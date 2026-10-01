import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

export const SALES_REPORT_LIMITS = {
  /** The longest period asked for at once. */
  days: 366,
} as const;

/** How a sales report divides its period: days, weeks from Monday, or months, in the shop's time. */
export const SALES_INTERVALS = ['day', 'week', 'month'] as const;
export type SalesIntervalValue = (typeof SALES_INTERVALS)[number];

export interface SalesReportInput {
  /** Orders placed at or after this… */
  placedFrom: Date;
  /** …and before this. */
  placedBefore: Date;
  interval: SalesIntervalValue;
  /** How many of the products that sold most. */
  topProducts: number;
}

/** What orders came to; minor units in the shop's currency. */
export interface SalesTally {
  /** Placed, cancelled ones aside. */
  orders: number;
  /** Their items at the prices sold. */
  grossSales: bigint;
  discounts: bigint;
  /** Items in parcels that came back, refused or undeliverable, at the prices sold. */
  returns: bigint;
  /** Delivery charges. */
  shipping: bigint;
  /** Fees for paying on delivery (CHK-08), as Shopify's reports count additional fees. */
  additionalFees: bigint;
}

export interface SalesPeriod extends SalesTally {
  /** When the day, week or month starts, in the shop's time zone. */
  start: Date;
}

export interface ProductSales {
  productId: string;
  /** As it was last sold. */
  title: string;
  unitsSold: number;
  orders: number;
  /** Its items at the prices sold. */
  grossSales: bigint;
}

export interface SalesReport {
  totals: SalesTally;
  /** Every day, week or month of the period, those without orders included. */
  periods: SalesPeriod[];
  /** The products that sold most, by what they came to. */
  topProducts: ProductSales[];
}

type PeriodRow = {
  start: Date | string;
  orders: number;
  gross: string;
  discounts: string;
  returns: string;
  shipping: string;
  fees: string;
};

type ProductRow = {
  product_id: string;
  title: string;
  units: number;
  orders: number;
  gross: string;
};

/**
 * Sales analytics (ANL-02): what a period's orders came to, as Shopify's sales reports give it,
 * day by day, week by week or month by month in the shop's time zone, and the products that sold
 * most. An order counts on the day it was placed, cancelled orders aside, and so do the items of
 * it that came back. Worked out from the orders when asked; nothing is stored.
 */
@Injectable()
export class SalesReportService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    input: SalesReportInput,
  ): Promise<MutationResult<SalesReport>> {
    const span = input.placedBefore.getTime() - input.placedFrom.getTime();
    if (span <= 0) {
      return failOne(['placedBefore'], 'INVALID', 'Placed before must be later than placed from');
    }
    if (span > SALES_REPORT_LIMITS.days * 86_400_000) {
      return failOne(
        ['placedBefore'],
        'INVALID',
        `A sales report covers at most ${SALES_REPORT_LIMITS.days} days at a time`,
      );
    }
    const { shopId } = tenant;
    const { placedFrom, placedBefore, interval } = input;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const placed = sql`
        SELECT o.id, o.subtotal, o.discount, o.shipping, o.cod_fee,
               date_trunc(${interval}, o.created_at AT TIME ZONE ${timezone}) AS bucket
          FROM orders.orders o
         WHERE o.shop_id = ${shopId} AND o.status <> 'cancelled'
           AND o.created_at >= ${placedFrom} AND o.created_at < ${placedBefore}`;
      const { rows: periods } = await tx.execute<PeriodRow>(sql`
        WITH placed AS (${placed}),
        returned AS (
          SELECT f.order_id, sum(fl.quantity * l.unit_price) AS value
            FROM orders.fulfillments f
            JOIN orders.fulfillment_lines fl
              ON fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id
            JOIN orders.lines l ON l.shop_id = fl.shop_id AND l.id = fl.line_id
           WHERE f.shop_id = ${shopId} AND f.status IN ('returning', 'returned', 'lost')
             AND f.order_id IN (SELECT id FROM placed)
           GROUP BY f.order_id
        ),
        sales AS (
          SELECT p.bucket, count(*)::int AS orders, sum(p.subtotal) AS gross,
                 sum(p.discount) AS discounts, coalesce(sum(r.value), 0) AS returns,
                 sum(p.shipping) AS shipping, sum(p.cod_fee) AS fees
            FROM placed p LEFT JOIN returned r ON r.order_id = p.id
           GROUP BY p.bucket
        ),
        buckets AS (
          SELECT generate_series(
                   date_trunc(${interval}, ${placedFrom}::timestamptz AT TIME ZONE ${timezone}),
                   date_trunc(${interval},
                     (${placedBefore}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone}),
                   ('1 ' || ${interval}::text)::interval) AS bucket
        )
        SELECT b.bucket AT TIME ZONE ${timezone} AS start, coalesce(s.orders, 0) AS orders,
               coalesce(s.gross, 0)::text AS gross, coalesce(s.discounts, 0)::text AS discounts,
               coalesce(s.returns, 0)::text AS returns, coalesce(s.shipping, 0)::text AS shipping,
               coalesce(s.fees, 0)::text AS fees
          FROM buckets b LEFT JOIN sales s ON s.bucket = b.bucket
         ORDER BY b.bucket`);
      const { rows: products } = await tx.execute<ProductRow>(sql`
        SELECT l.product_id::text AS product_id,
               (array_agg(l.title ORDER BY o.created_at DESC, o.id DESC))[1] AS title,
               sum(l.quantity)::int AS units, count(DISTINCT o.id)::int AS orders,
               sum(l.total)::text AS gross
          FROM orders.orders o
          JOIN orders.lines l ON l.shop_id = o.shop_id AND l.order_id = o.id
         WHERE o.shop_id = ${shopId} AND o.status <> 'cancelled'
           AND o.created_at >= ${placedFrom} AND o.created_at < ${placedBefore}
         GROUP BY l.product_id
         ORDER BY sum(l.total) DESC, sum(l.quantity) DESC, l.product_id
         LIMIT ${input.topProducts}`);
      const report: SalesReport = {
        totals: {
          orders: 0,
          grossSales: 0n,
          discounts: 0n,
          returns: 0n,
          shipping: 0n,
          additionalFees: 0n,
        },
        periods: periods.map((row) => ({
          start: new Date(row.start),
          orders: row.orders,
          grossSales: BigInt(row.gross),
          discounts: BigInt(row.discounts),
          returns: BigInt(row.returns),
          shipping: BigInt(row.shipping),
          additionalFees: BigInt(row.fees),
        })),
        topProducts: products.map((row) => ({
          productId: row.product_id,
          title: row.title,
          unitsSold: row.units,
          orders: row.orders,
          grossSales: BigInt(row.gross),
        })),
      };
      for (const period of report.periods) {
        report.totals.orders += period.orders;
        report.totals.grossSales += period.grossSales;
        report.totals.discounts += period.discounts;
        report.totals.returns += period.returns;
        report.totals.shipping += period.shipping;
        report.totals.additionalFees += period.additionalFees;
      }
      return { ok: true, value: report };
    });
  }
}

/** Gross sales less discounts and returns. */
export function netSales(tally: SalesTally): bigint {
  return tally.grossSales - tally.discounts - tally.returns;
}

/**
 * What an order came to on average, as Shopify works it out: gross sales less discounts, over
 * the orders, rounded to the nearest minor unit; null without orders.
 */
export function averageOrderValue(tally: SalesTally): bigint | null {
  if (tally.orders === 0) return null;
  const orders = BigInt(tally.orders);
  return ((tally.grossSales - tally.discounts) * 2n + orders) / (orders * 2n);
}

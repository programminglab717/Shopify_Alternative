import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  NO_CAMPAIGN,
  VISIT_CAMPAIGN_SQL,
  VISIT_SOURCE_SQL,
  visitSourceTitle,
} from './attribution.js';
import { ORDER_SOURCE_TITLES } from './cod-health.service.js';
import type { OrderSourceValue } from './schema.js';

export const SALES_REPORT_LIMITS = {
  /** The longest period asked for at once. */
  days: 366,
} as const;

/** How a sales report divides its period: days, weeks from Monday, or months, in the shop's time. */
export const SALES_INTERVALS = ['day', 'week', 'month'] as const;
export type SalesIntervalValue = (typeof SALES_INTERVALS)[number];

/**
 * What a sales report breaks its sales down by: the orders' channels (`source`), or where their
 * last visits from elsewhere came from and their campaigns (ADR-140).
 */
export const SALES_DIMENSIONS = ['source', 'visit_source', 'campaign'] as const;
export type SalesDimension = (typeof SALES_DIMENSIONS)[number];

export interface SalesReportInput {
  /** Orders placed at or after this… */
  placedFrom: Date;
  /** …and before this. */
  placedBefore: Date;
  interval: SalesIntervalValue;
  /** How many of the products that sold most. */
  topProducts: number;
  by?: SalesDimension | null;
  /** Rows at most, by `by`, most sales first. */
  first?: number;
}

/**
 * What orders came to; minor units in the shop's currency. Prices include the shop's sales tax,
 * and every amount but `taxes` leaves it out, as Shopify's reports do (ADR-117).
 */
export interface SalesTally {
  /** Placed, cancelled ones aside. */
  orders: number;
  /** Their items at the prices sold, without the tax those prices include. */
  grossSales: bigint;
  /** What was taken off the items, without its share of their tax. */
  discounts: bigint;
  /**
   * Items in parcels that came back, refused or undeliverable, at the prices sold, less the tax
   * that came back with them.
   */
  returns: bigint;
  /** Delivery charges, without their tax. */
  shipping: bigint;
  /**
   * Fees for paying on delivery (CHK-08), as Shopify's reports count additional fees, without
   * their tax.
   */
  additionalFees: bigint;
  /**
   * The sales tax the orders include (ADR-105): the orders', less that of the items that came
   * back. Total sales add it back to the other amounts.
   */
  taxes: bigint;
  /**
   * What the items kept cost the shop (ADR-141): their units at what each cost when sold, those
   * that came back aside. Units sold without a cost count nothing.
   */
  costOfGoods: bigint;
  /** Units sold whose variant had no cost when they were sold. */
  unitsWithoutCost: number;
  /** What couriers' statements charged for the orders' parcels, out and back (ADR-088). */
  shippingCosts: bigint;
  /**
   * What the items written off cost when sold: those of parcels that came back and were not
   * restocked, of parcels lost, and of customers' returns checked in and not restocked.
   */
  writeOffs: bigint;
  /** What couriers paid of claims for parcels lost or damaged (ADR-093, ADR-098). */
  claimsRecovered: bigint;
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
  /** Its items at the prices sold, without their tax. */
  grossSales: bigint;
  /** What its units sold cost when sold; those without a cost count nothing. */
  costOfGoods: bigint;
}

/** What the orders of one channel, source or campaign came to. */
export interface SalesRow extends SalesTally {
  /**
   * The channel, where the visits came from as they keep it, or the campaign in the spelling most
   * used; null for orders without a visit, or a campaign.
   */
  key: string | null;
  title: string;
}

export interface SalesReport {
  totals: SalesTally;
  /** Every day, week or month of the period, those without orders included. */
  periods: SalesPeriod[];
  /** The products that sold most, by what they came to. */
  topProducts: ProductSales[];
  /** By what `by` names, most total sales first; none without it. */
  rows: SalesRow[];
}

type TallyRow = {
  orders: number;
  gross: string;
  discounts: string;
  returns: string;
  shipping: string;
  fees: string;
  taxes: string;
  cost: string;
  uncosted: number;
  shipping_costs: string;
  write_offs: string;
  claims: string;
};

type PeriodRow = TallyRow & { start: Date | string };

type GroupRow = TallyRow & { key: string | null; title: string | null };

/** How a dimension groups orders, and spells its rows' keys: the order is `o`. */
const SALES_GROUPS: Readonly<Record<SalesDimension, { key: SQL; title: SQL }>> = {
  source: { key: sql`o.source`, title: sql`o.source` },
  visit_source: { key: VISIT_SOURCE_SQL, title: VISIT_SOURCE_SQL },
  // Campaigns in any letter case are one, as COD health has them.
  campaign: { key: sql`lower(${VISIT_CAMPAIGN_SQL})`, title: VISIT_CAMPAIGN_SQL },
};

type ProductRow = {
  product_id: string;
  title: string;
  units: number;
  orders: number;
  gross: string;
  cost: string;
};

/**
 * The tax `amount` includes at `rate` hundredths of a percent, none at a null rate, in SQL, as
 * the tax module's `includedTax` works it out: rounded half up.
 */
function includedTaxIn(amount: SQL, rate: SQL): SQL {
  return sql`CASE WHEN ${rate} IS NULL OR ${amount} <= 0 THEN 0
                  ELSE round(${amount}::numeric * ${rate} / (10000 + ${rate})) END`;
}

/**
 * Sales analytics (ANL-02): what a period's orders came to, as Shopify's sales reports give it,
 * day by day, week by week or month by month in the shop's time zone, the products that sold
 * most, and by channel, or by where the orders' last visits came from or their campaigns
 * (ADR-140). An order counts on the day it was placed, cancelled orders aside, and so do the
 * items of it that came back. Amounts leave out the sales tax prices include, which is said
 * apart, from what each order keeps of it (ADR-117). Worked out from the orders when asked;
 * nothing is stored.
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
    const { placedFrom, placedBefore } = input;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const periods = await salesPeriodsIn(tx, shopId, timezone, input);
      const gross = sql`sum(l.total - ${includedTaxIn(sql`l.total`, sql`l.tax_rate`)})`;
      const { rows: products } = await tx.execute<ProductRow>(sql`
        SELECT l.product_id::text AS product_id,
               (array_agg(l.title ORDER BY o.created_at DESC, o.id DESC))[1] AS title,
               sum(l.quantity)::int AS units, count(DISTINCT o.id)::int AS orders,
               ${gross}::bigint::text AS gross,
               coalesce(sum(l.quantity * l.unit_cost), 0)::text AS cost
          FROM orders.orders o
          JOIN orders.lines l ON l.shop_id = o.shop_id AND l.order_id = o.id
         WHERE o.shop_id = ${shopId} AND o.status <> 'cancelled'
           AND o.created_at >= ${placedFrom} AND o.created_at < ${placedBefore}
         GROUP BY l.product_id
         ORDER BY ${gross} DESC, sum(l.quantity) DESC, l.product_id
         LIMIT ${input.topProducts}`);
      const report: SalesReport = {
        totals: tallyOf(periods),
        periods,
        topProducts: products.map((row) => ({
          productId: row.product_id,
          title: row.title,
          unitsSold: row.units,
          orders: row.orders,
          grossSales: BigInt(row.gross),
          costOfGoods: BigInt(row.cost),
        })),
        rows: input.by ? await salesRowsIn(tx, shopId, input, input.by, input.first ?? 50) : [],
      };
      return { ok: true, value: report };
    });
  }
}

/**
 * The orders placed in a period, as `placed`, and what they came to by `key`, an expression of
 * the order `o`, as `sales`, with `title`'s spelling most used in each: the start of a `WITH` the
 * caller ends with its own select from `sales`.
 */
function salesWith(
  shopId: string,
  { placedFrom, placedBefore }: Pick<SalesReportInput, 'placedFrom' | 'placedBefore'>,
  key: SQL,
  title: SQL = sql`NULL::text`,
): SQL {
  // Each order's items without the tax their prices include, line by line at the rate each
  // was taxed at, and the share of its charges' tax that is its delivery charge's, in
  // proportion; the rest is its fee's.
  const placed = sql`
    SELECT o.id, o.subtotal, o.discount, o.shipping, o.cod_fee, o.total_tax, o.shipping_tax,
           (SELECT coalesce(sum(l.total - ${includedTaxIn(sql`l.total`, sql`l.tax_rate`)}), 0)
              FROM orders.lines l
             WHERE l.shop_id = o.shop_id AND l.order_id = o.id) AS gross,
           CASE WHEN o.shipping + o.cod_fee > 0
                THEN round(o.shipping_tax::numeric * o.shipping / (o.shipping + o.cod_fee))
                ELSE 0 END AS shipping_tax_part,
           -- What its units cost when sold, and how many had no cost (ADR-141).
           (SELECT coalesce(sum(l.quantity * l.unit_cost), 0)
              FROM orders.lines l
             WHERE l.shop_id = o.shop_id AND l.order_id = o.id) AS cost,
           (SELECT coalesce(sum(l.quantity) FILTER (WHERE l.unit_cost IS NULL), 0)
              FROM orders.lines l
             WHERE l.shop_id = o.shop_id AND l.order_id = o.id) AS uncosted,
           -- What couriers charged for its parcels, and paid of their claims.
           (SELECT coalesce(sum(f.courier_charges), 0)
              FROM orders.fulfillments f
             WHERE f.shop_id = o.shop_id AND f.order_id = o.id) AS shipping_costs,
           (SELECT coalesce(sum(f.claim_paid), 0)
              FROM orders.fulfillments f
             WHERE f.shop_id = o.shop_id AND f.order_id = o.id) AS claims,
           ${key} AS key, ${title} AS title
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.status <> 'cancelled'
       AND o.created_at >= ${placedFrom} AND o.created_at < ${placedBefore}`;
  return sql`
    WITH placed AS (${placed}),
    -- What came back: parcels refused or lost, and what customers sent back of those delivered
    -- (ADR-136), unless they kept it after all.
    back AS (
      SELECT f.order_id, fl.line_id, fl.quantity
        FROM orders.fulfillments f
        JOIN orders.fulfillment_lines fl
          ON fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id
       WHERE f.shop_id = ${shopId} AND f.status IN ('returning', 'returned', 'lost')
         AND f.order_id IN (SELECT id FROM placed)
      UNION ALL
      SELECT rt.order_id, rl.line_id, rl.quantity
        FROM orders.returns rt
        JOIN orders.return_lines rl ON rl.shop_id = rt.shop_id AND rl.return_id = rt.id
       WHERE rt.shop_id = ${shopId} AND rt.status <> 'cancelled'
         AND rt.order_id IN (SELECT id FROM placed)
    ),
    returned AS (
      SELECT b.order_id, sum(b.quantity * l.unit_price) AS value,
             -- Each line's tax shared by its items, rounded line by line.
             sum(round(b.quantity::numeric * l.tax / l.quantity)) AS tax,
             coalesce(sum(b.quantity * l.unit_cost), 0) AS cost
        FROM back b
        JOIN orders.lines l ON l.shop_id = ${shopId} AND l.id = b.line_id
       GROUP BY b.order_id
    ),
    -- What of it was written off: parcels checked back in short of restocking it, parcels lost,
    -- and customers' returns checked in short of it. What is still on its way back is neither.
    written AS (
      SELECT w.order_id, coalesce(sum(w.quantity * l.unit_cost), 0) AS cost
        FROM (SELECT f.order_id, fl.line_id,
                     CASE WHEN f.status = 'lost' THEN fl.quantity
                          ELSE fl.quantity - coalesce(fl.restocked_quantity, 0) END AS quantity
                FROM orders.fulfillments f
                JOIN orders.fulfillment_lines fl
                  ON fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id
               WHERE f.shop_id = ${shopId} AND f.status IN ('returned', 'lost')
                 AND f.order_id IN (SELECT id FROM placed)
              UNION ALL
              SELECT rt.order_id, rl.line_id, rl.quantity - coalesce(rl.restocked_quantity, 0)
                FROM orders.returns rt
                JOIN orders.return_lines rl ON rl.shop_id = rt.shop_id AND rl.return_id = rt.id
               WHERE rt.shop_id = ${shopId} AND rt.status = 'closed'
                 AND rt.order_id IN (SELECT id FROM placed)) w
        JOIN orders.lines l ON l.shop_id = ${shopId} AND l.id = w.line_id
       GROUP BY w.order_id
    ),
    -- What was paid for the items, less their tax, is what they came to less the discounts;
    -- so the discounts are the difference, their tax left out. Returns leave out the tax that
    -- went back with them, which taxes do too, so total sales stay what was paid less them.
    sales AS (
      SELECT p.key, mode() WITHIN GROUP (ORDER BY p.title) AS title,
             count(*)::int AS orders, sum(p.gross) AS gross,
             sum(p.gross - (p.subtotal - p.discount - (p.total_tax - p.shipping_tax)))
               AS discounts,
             coalesce(sum(r.value - r.tax), 0) AS returns,
             sum(p.shipping - p.shipping_tax_part) AS shipping,
             sum(p.cod_fee - (p.shipping_tax - p.shipping_tax_part)) AS fees,
             sum(p.total_tax) - coalesce(sum(r.tax), 0) AS taxes,
             sum(p.cost) - coalesce(sum(r.cost), 0) AS cost,
             sum(p.uncosted)::int AS uncosted,
             sum(p.shipping_costs) AS shipping_costs,
             coalesce(sum(w.cost), 0) AS write_offs,
             sum(p.claims) AS claims
        FROM placed p
        LEFT JOIN returned r ON r.order_id = p.id
        LEFT JOIN written w ON w.order_id = p.id
       GROUP BY p.key
    )`;
}

/** A tally's columns, as `salesWith`'s `sales` has them, zero where a row has none. */
const TALLY_COLUMNS = sql`
  coalesce(s.orders, 0) AS orders,
  coalesce(s.gross, 0)::bigint::text AS gross,
  coalesce(s.discounts, 0)::bigint::text AS discounts,
  coalesce(s.returns, 0)::bigint::text AS returns,
  coalesce(s.shipping, 0)::bigint::text AS shipping,
  coalesce(s.fees, 0)::bigint::text AS fees,
  coalesce(s.taxes, 0)::bigint::text AS taxes,
  coalesce(s.cost, 0)::bigint::text AS cost,
  coalesce(s.uncosted, 0) AS uncosted,
  coalesce(s.shipping_costs, 0)::bigint::text AS shipping_costs,
  coalesce(s.write_offs, 0)::bigint::text AS write_offs,
  coalesce(s.claims, 0)::bigint::text AS claims`;

function tallyOfRow(row: TallyRow): SalesTally {
  return {
    orders: row.orders,
    grossSales: BigInt(row.gross),
    discounts: BigInt(row.discounts),
    returns: BigInt(row.returns),
    shipping: BigInt(row.shipping),
    additionalFees: BigInt(row.fees),
    taxes: BigInt(row.taxes),
    costOfGoods: BigInt(row.cost),
    unitsWithoutCost: row.uncosted,
    shippingCosts: BigInt(row.shipping_costs),
    writeOffs: BigInt(row.write_offs),
    claimsRecovered: BigInt(row.claims),
  };
}

/**
 * What the orders placed in a period came to, its every day, week or month in the shop's time
 * zone `timezone`, those without orders included; in the caller's transaction `tx`, for the report
 * and for the home's today (ADR-121).
 */
export async function salesPeriodsIn(
  tx: Tx,
  shopId: string,
  timezone: string,
  period: Pick<SalesReportInput, 'placedFrom' | 'placedBefore' | 'interval'>,
): Promise<SalesPeriod[]> {
  const { placedFrom, placedBefore, interval } = period;
  const bucket = sql`date_trunc(${interval}, o.created_at AT TIME ZONE ${timezone})`;
  const { rows } = await tx.execute<PeriodRow>(sql`
    ${salesWith(shopId, period, bucket)},
    buckets AS (
      SELECT generate_series(
               date_trunc(${interval}, ${placedFrom}::timestamptz AT TIME ZONE ${timezone}),
               date_trunc(${interval},
                 (${placedBefore}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone}),
               ('1 ' || ${interval}::text)::interval) AS bucket
    )
    SELECT b.bucket AT TIME ZONE ${timezone} AS start, ${TALLY_COLUMNS}
      FROM buckets b LEFT JOIN sales s ON s.key = b.bucket
     ORDER BY b.bucket`);
  return rows.map((row) => ({ start: new Date(row.start), ...tallyOfRow(row) }));
}

/**
 * What the orders placed in a period came to by `by`, most total sales first, then most orders,
 * at most `first` rows; in the caller's transaction `tx`.
 */
async function salesRowsIn(
  tx: Tx,
  shopId: string,
  period: Pick<SalesReportInput, 'placedFrom' | 'placedBefore'>,
  by: SalesDimension,
  first: number,
): Promise<SalesRow[]> {
  const group = SALES_GROUPS[by];
  const { rows } = await tx.execute<GroupRow>(sql`
    ${salesWith(shopId, period, group.key, group.title)}
    SELECT s.key, s.title, ${TALLY_COLUMNS} FROM sales s`);
  return rows
    .map((row): SalesRow => ({ ...rowName(by, row), ...tallyOfRow(row) }))
    .sort(
      (a, b) =>
        Number(totalSales(b) - totalSales(a)) ||
        b.orders - a.orders ||
        a.title.localeCompare(b.title),
    )
    .slice(0, first);
}

/** A row's key and title, as its dimension names it. */
function rowName(by: SalesDimension, row: GroupRow): Pick<SalesRow, 'key' | 'title'> {
  switch (by) {
    case 'source':
      return { key: row.key, title: ORDER_SOURCE_TITLES[row.key as OrderSourceValue] };
    case 'visit_source':
      return { key: row.key, title: visitSourceTitle(row.key) };
    case 'campaign':
      return row.key === null
        ? { key: null, title: NO_CAMPAIGN }
        : { key: row.title ?? row.key, title: row.title ?? row.key };
  }
}

/** Periods' sales added up. */
export function tallyOf(periods: readonly SalesTally[]): SalesTally {
  const tally: SalesTally = {
    orders: 0,
    grossSales: 0n,
    discounts: 0n,
    returns: 0n,
    shipping: 0n,
    additionalFees: 0n,
    taxes: 0n,
    costOfGoods: 0n,
    unitsWithoutCost: 0,
    shippingCosts: 0n,
    writeOffs: 0n,
    claimsRecovered: 0n,
  };
  for (const period of periods) {
    tally.orders += period.orders;
    tally.grossSales += period.grossSales;
    tally.discounts += period.discounts;
    tally.returns += period.returns;
    tally.shipping += period.shipping;
    tally.additionalFees += period.additionalFees;
    tally.taxes += period.taxes;
    tally.costOfGoods += period.costOfGoods;
    tally.unitsWithoutCost += period.unitsWithoutCost;
    tally.shippingCosts += period.shippingCosts;
    tally.writeOffs += period.writeOffs;
    tally.claimsRecovered += period.claimsRecovered;
  }
  return tally;
}

/** Gross sales less discounts and returns. */
export function netSales(tally: SalesTally): bigint {
  return tally.grossSales - tally.discounts - tally.returns;
}

/**
 * Net sales, shipping, additional fees and taxes, as Shopify adds them up: what the orders came
 * to, less what came back.
 */
export function totalSales(tally: SalesTally): bigint {
  return netSales(tally) + tally.shipping + tally.additionalFees + tally.taxes;
}

/** Net sales less the cost of the goods kept, as Shopify works out gross profit (ADR-141). */
export function grossProfit(tally: SalesTally): bigint {
  return netSales(tally) - tally.costOfGoods;
}

/**
 * What the orders made (ANL-03, ADR-141): what they came to less what came back and the tax they
 * include, less what their goods cost, what couriers charged and what was written off, and plus
 * what couriers paid of claims.
 */
export function profit(tally: SalesTally): bigint {
  return (
    totalSales(tally) -
    tally.taxes -
    tally.costOfGoods -
    tally.shippingCosts -
    tally.writeOffs +
    tally.claimsRecovered
  );
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

import { shopProfile, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { XLSX_CONTENT_TYPE, toXlsx, type XlsxColumn } from '@hatti/xlsx';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { orderName } from './rules.js';

/**
 * How long cash has waited since its parcel was delivered, in whole days: a week, a fortnight, a
 * month, and longer. The last has no end.
 */
export const RECEIVABLE_AGES = [
  { fromDays: 0, toDays: 7 },
  { fromDays: 8, toDays: 14 },
  { fromDays: 15, toDays: 30 },
  { fromDays: 31, toDays: null },
] as const;

/** Orders, and the cash on delivery they still owe the shop, in minor units. */
export interface CodCash {
  count: number;
  amount: bigint;
}

/** Cash owed on parcels delivered between `fromDays` and `toDays` days ago. */
export interface ReceivableAge extends CodCash {
  fromDays: number;
  /** Null for the oldest: no end. */
  toDays: number | null;
}

/** What one courier owes, as staff named it. */
export interface CourierReceivables {
  /** As staff named it most often; null for parcels shipped without a courier named. */
  courier: string | null;
  owed: CodCash;
  ages: ReceivableAge[];
  /** When the parcel whose cash has waited longest was delivered. */
  oldestDeliveredAt: Date;
}

/** The cash on delivery couriers hold for the shop (COD-10). */
export interface CodReceivables {
  /** Delivered, and not yet received: what couriers owe. */
  owed: CodCash;
  ages: ReceivableAge[];
  /** On parcels still on their way, not yet collected. */
  onTheWay: CodCash;
  /** The most owed first. */
  couriers: CourierReceivables[];
}

type AgeRow = {
  key: string | null;
  title: string | null;
  age: number;
  count: number;
  amount: string;
  oldest: Date | string;
};

type OnTheWayRow = { count: number; amount: string };

/**
 * The cash on delivery couriers hold for the shop (COD-10): on cash-on-delivery orders that are
 * delivered and not yet paid, what they still owe, `total - amount_paid`, by courier and by how
 * long it has waited since the parcel was delivered; and what is still on its way. Together they
 * are the home's cash still to come. Worked out from the orders when asked: they are few, those
 * waiting for their cash, and the stage index finds them.
 */
@Injectable()
export class CodReceivablesService {
  constructor(private readonly db: Database) {}

  /** As it stands at `at`, which ages count up to. */
  async report(tenant: TenantContext, at: Date = new Date()): Promise<CodReceivables> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const ages = await tx.execute<AgeRow>(sql`
        WITH delivered AS (
          SELECT o.total - o.amount_paid AS owed,
                 last.delivered_at,
                 nullif(btrim(last.tracking_company), '') AS courier,
                 floor(extract(epoch FROM (${at.toISOString()}::timestamptz - last.delivered_at))
                       / 86400)::int AS days
            FROM orders.orders o
            JOIN LATERAL (
              SELECT f.delivered_at, f.tracking_company
                FROM orders.fulfillments f
               WHERE f.shop_id = o.shop_id AND f.order_id = o.id AND f.status = 'delivered'
               ORDER BY f.delivered_at DESC
               LIMIT 1
            ) last ON true
           WHERE o.shop_id = ${tenant.shopId}
             AND o.stage = 'delivered'
             AND o.payment_method = 'cash_on_delivery'
             AND o.amount_paid < o.total
        ),
        titles AS (
          SELECT lower(courier) AS key, mode() WITHIN GROUP (ORDER BY courier) AS title
            FROM delivered
           GROUP BY 1
        )
        SELECT t.key, t.title, ${ageOf(sql.raw('d.days'))} AS age, count(*)::int AS count,
               sum(d.owed)::text AS amount, min(d.delivered_at) AS oldest
          FROM delivered d
          JOIN titles t ON t.key IS NOT DISTINCT FROM lower(d.courier)
         GROUP BY t.key, t.title, 3`);
      const {
        rows: [onTheWay],
      } = await tx.execute<OnTheWayRow>(sql`
        SELECT count(*)::int AS count, coalesce(sum(total - amount_paid), 0)::text AS amount
          FROM orders.orders
         WHERE shop_id = ${tenant.shopId}
           AND stage IN ('partially_fulfilled', 'in_transit')
           AND payment_method = 'cash_on_delivery'
           AND amount_paid < total`);
      const couriers = new Map<string | null, AgeRow[]>();
      for (const row of ages.rows) couriers.set(row.key, [...(couriers.get(row.key) ?? []), row]);
      const report = [...couriers.values()].map((rows): CourierReceivables => {
        const owed = cashOf(rows);
        const oldest = rows.reduce((first, row) => {
          const when = new Date(row.oldest);
          return when < first ? when : first;
        }, new Date(rows[0]!.oldest));
        return { courier: rows[0]!.title, owed, ages: agesOf(rows), oldestDeliveredAt: oldest };
      });
      report.sort(
        (a, b) =>
          Number(b.owed.amount - a.owed.amount) ||
          // Couriers named before none, then by name.
          Number(a.courier === null) - Number(b.courier === null) ||
          (a.courier ?? '').localeCompare(b.courier ?? ''),
      );
      return {
        owed: cashOf(ages.rows),
        ages: agesOf(ages.rows),
        onTheWay: { count: onTheWay?.count ?? 0, amount: BigInt(onTheWay?.amount ?? 0) },
        couriers: report,
      };
    });
  }

  /**
   * The dispute sheet of the cash `courier` has held `olderThanDays` days or more (ADR-605): a
   * week unless said, at most a year.
   */
  async disputeSheet(
    tenant: TenantContext,
    courier: string | null,
    olderThanDays: number = DISPUTE_DAYS.default,
    at: Date = new Date(),
  ): Promise<CodDisputeSheet> {
    const days = Math.min(Math.max(Math.trunc(olderThanDays), 0), DISPUTE_DAYS.max);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, tenant.shopId);
      return codDisputeSheetIn(
        tx,
        tenant.shopId,
        {
          courier: courier?.slice(0, 200) ?? null,
          olderThanDays: days,
          timeZone: timezone,
          currency: tenant.currency,
        },
        at,
      );
    });
  }
}

/** The index in {@link RECEIVABLE_AGES} of `days`, in SQL. */
function ageOf(days: ReturnType<typeof sql.raw>) {
  const bounded = RECEIVABLE_AGES.flatMap((age, index) =>
    age.toDays === null
      ? []
      : [sql`WHEN ${days} <= ${sql.raw(String(age.toDays))} THEN ${sql.raw(String(index))}`],
  );
  return sql`(CASE ${sql.join(bounded, sql` `)} ELSE ${sql.raw(String(RECEIVABLE_AGES.length - 1))} END)`;
}

function cashOf(rows: readonly AgeRow[]): CodCash {
  return {
    count: rows.reduce((sum, row) => sum + row.count, 0),
    amount: rows.reduce((sum, row) => sum + BigInt(row.amount), 0n),
  };
}

/** Every age, those with nothing owed too, so that reports line up. */
function agesOf(rows: readonly AgeRow[]): ReceivableAge[] {
  return RECEIVABLE_AGES.map((age, index) => ({
    ...age,
    ...cashOf(rows.filter((row) => row.age === index)),
  }));
}

/** What a dispute sheet lists at least, by default: cash a courier has held a week or more. */
export const DISPUTE_DAYS = { default: 7, max: 365 } as const;

/** A dispute sheet: the workbook to send a courier, and how many parcels it lists. */
export interface CodDisputeSheet {
  filename: string;
  contentType: string;
  content: Buffer;
  rows: number;
}

type DisputeRow = {
  tracking_number: string | null;
  number: number;
  delivered_at: Date | string;
  city: string | null;
  total: string;
  amount_paid: string;
  courier: string | null;
};

/** A dispute sheet's columns: the parcel, when it was delivered, and its cash, paid and owed. */
const DISPUTE_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Tracking number' },
  { header: 'Order' },
  { header: 'Delivered', type: 'time' },
  { header: 'Days since delivery', type: 'number' },
  { header: 'City' },
  { header: 'Cash to collect', type: 'amount' },
  { header: 'Received', type: 'amount' },
  { header: 'Still owed', type: 'amount' },
  { header: 'Courier' },
];

/**
 * The parcels a courier delivered `olderThanDays` or more days before `at` whose cash the shop has
 * not had in full (COD-10, ADR-605), as an Excel workbook to send them: by tracking number, the
 * oldest first, each with what it was to collect, what of it came, by a statement or by hand, and
 * what is still owed. The courier is as staff named it, in any letter case; null for parcels
 * shipped without one named. Times are in the shop's time zone.
 */
export async function codDisputeSheetIn(
  tx: Tx,
  shopId: string,
  input: { courier: string | null; olderThanDays: number; timeZone: string; currency: string },
  at: Date = new Date(),
): Promise<CodDisputeSheet> {
  const { rows } = await tx.execute<DisputeRow>(sql`
    SELECT last.tracking_number, o.number, last.delivered_at,
           o.shipping_address ->> 'city' AS city, o.total::text, o.amount_paid::text,
           nullif(btrim(last.tracking_company), '') AS courier
      FROM orders.orders o
      JOIN LATERAL (
        SELECT f.delivered_at, f.tracking_company, f.tracking_number
          FROM orders.fulfillments f
         WHERE f.shop_id = o.shop_id AND f.order_id = o.id AND f.status = 'delivered'
         ORDER BY f.delivered_at DESC
         LIMIT 1
      ) last ON true
     WHERE o.shop_id = ${shopId}
       AND o.stage = 'delivered'
       AND o.payment_method = 'cash_on_delivery'
       AND o.amount_paid < o.total
       AND lower(nullif(btrim(last.tracking_company), ''))
           IS NOT DISTINCT FROM lower(nullif(btrim(${input.courier}::text), ''))
       AND last.delivered_at <= ${at.toISOString()}::timestamptz
                                - make_interval(days => ${input.olderThanDays})
     ORDER BY last.delivered_at, o.number`);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const when = (value: Date) => {
    const part = (type: string) => time.formatToParts(value).find((p) => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  };
  const amount = (minor: bigint) => toMajorString(money(minor, input.currency as CurrencyCode));
  const sheet = rows.map((row) => {
    const delivered = new Date(row.delivered_at);
    const total = BigInt(row.total);
    const paid = BigInt(row.amount_paid);
    return [
      row.tracking_number,
      orderName(row.number),
      when(delivered),
      Math.floor((at.getTime() - delivered.getTime()) / 86_400_000),
      row.city,
      amount(total),
      amount(paid),
      amount(total - paid),
      row.courier,
    ];
  });
  const named = (input.courier?.trim() || 'no-courier')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    filename: `dispute-${named || 'courier'}-${when(at).slice(0, 10)}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    content: toXlsx({ name: 'Cash owed', columns: DISPUTE_COLUMNS, rows: sheet }),
    rows: sheet.length,
  };
}

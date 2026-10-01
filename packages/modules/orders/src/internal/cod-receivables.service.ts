import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

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

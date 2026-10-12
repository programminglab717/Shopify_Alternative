import { shopProfile, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { parcelWorth } from './parcel-claims.js';
import type { OrderTally } from './records.js';
import { salesPeriodsIn, tallyOf, totalSales } from './sales-report.service.js';

/** How the shop's day has gone so far, for the admin's home (ANL-01, ADR-121). */
export interface OrderToday {
  /** When today began: midnight in the shop's time zone. */
  since: Date;
  /**
   * Orders placed today, cancelled ones aside, and their total sales, as the sales report works
   * them out for today.
   */
  sales: OrderTally;
  /**
   * The same of yesterday until this time of day, to compare with (ADR-250): from yesterday's
   * midnight, for as long as today has gone.
   */
  salesYesterday: OrderTally;
  /** Parcels delivered today, and their worth: their items at the prices sold. */
  delivered: OrderTally;
  /** Parcels their couriers turned back today, refused or undeliverable, and their worth. */
  returnedToOrigin: OrderTally;
}

type ParcelsRow = { kind: 'delivered' | 'returned_to_origin'; count: number; total: string };

/** The parcels delivered and turned back from `since` until `until`, and their worth. */
async function parcelsIn(
  tx: Tx,
  shopId: string,
  since: Date,
  until: Date,
): Promise<{ delivered: OrderTally; returnedToOrigin: OrderTally }> {
  const { rows } = await tx.execute<ParcelsRow>(sql`
    SELECT 'delivered' AS kind, count(*)::int AS count, coalesce(sum(worth), 0)::text AS total
      FROM (SELECT ${parcelWorth(sql`f`)} AS worth FROM orders.fulfillments f
             WHERE f.shop_id = ${shopId}
               AND f.delivered_at >= ${since} AND f.delivered_at < ${until}) d
    UNION ALL
    SELECT 'returned_to_origin', count(*)::int, coalesce(sum(worth), 0)::text
      FROM (SELECT ${parcelWorth(sql`f`)} AS worth FROM orders.fulfillments f
             WHERE f.shop_id = ${shopId}
               AND f.returning_at >= ${since} AND f.returning_at < ${until}) r`);
  const parcels = (kind: ParcelsRow['kind']): OrderTally => {
    const row = rows.find((each) => each.kind === kind)!;
    return { count: row.count, total: BigInt(row.total) };
  };
  return { delivered: parcels('delivered'), returnedToOrigin: parcels('returned_to_origin') };
}

/** The day before, for the shop's owner each morning (ANL-07, ADR-386). */
export interface OrderDay {
  /** The day by the shop's clock, as "2026-10-11". */
  date: string;
  /** The hour it is at the time asked, by the shop's clock: 0 to 23. */
  hour: number;
  /** Orders placed that day, cancelled ones aside, and their total sales. */
  sales: OrderTally;
  /** Parcels delivered that day, and their worth. */
  delivered: OrderTally;
  /** Parcels their couriers turned back that day, and their worth. */
  returnedToOrigin: OrderTally;
  /**
   * Cash still to come at the time asked, on cash-on-delivery orders on their way or delivered and
   * not yet paid for: as the admin's home has it.
   */
  cashToCollect: OrderTally;
}

/**
 * The day before `at` by the shop's clock (ANL-07, ADR-386), in the caller's transaction: its
 * sales, and its parcels delivered and turned back, as today's on the home are worked out; and the
 * cash still to collect at `at`.
 */
export async function yesterdayIn(tx: Tx, shopId: string, at: Date): Promise<OrderDay> {
  const { timezone } = await shopProfile(tx, shopId);
  const { rows: days } = await tx.execute<{
    since: Date | string;
    until: Date | string;
    date: string;
    hour: number;
  }>(sql`
    SELECT (date_trunc('day', ${at}::timestamptz AT TIME ZONE ${timezone}) - interval '1 day')
             AT TIME ZONE ${timezone} AS since,
           date_trunc('day', ${at}::timestamptz AT TIME ZONE ${timezone})
             AT TIME ZONE ${timezone} AS until,
           to_char(date_trunc('day', ${at}::timestamptz AT TIME ZONE ${timezone})
                     - interval '1 day', 'YYYY-MM-DD') AS date,
           extract(hour FROM ${at}::timestamptz AT TIME ZONE ${timezone})::int AS hour`);
  const since = new Date(days[0]!.since);
  const until = new Date(days[0]!.until);
  const sales = tallyOf(
    await salesPeriodsIn(tx, shopId, timezone, {
      placedFrom: since,
      placedBefore: until,
      interval: 'day',
    }),
  );
  const { rows: cash } = await tx.execute<{ count: number; total: string }>(sql`
    SELECT count(*)::int AS count, coalesce(sum(total - amount_paid), 0)::text AS total
      FROM orders.orders
     WHERE shop_id = ${shopId} AND stage IN ('partially_fulfilled', 'in_transit', 'delivered')
       AND payment_method = 'cash_on_delivery' AND amount_paid < total`);
  return {
    date: days[0]!.date,
    hour: days[0]!.hour,
    sales: { count: sales.orders, total: totalSales(sales) },
    ...(await parcelsIn(tx, shopId, since, until)),
    cashToCollect: { count: cash[0]!.count, total: BigInt(cash[0]!.total) },
  };
}

/**
 * Today on the admin's home (ANL-01): the day so far in the shop's time zone, from its midnight,
 * worked out when asked from the orders and their parcels, each over an index of its own (ADR-121).
 */
@Injectable()
export class TodayService {
  constructor(private readonly db: Database) {}

  async today(tenant: TenantContext): Promise<OrderToday> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      // Today's midnight and tomorrow's, by the shop's clock: where clocks change, a day may be
      // 23 hours long or 25.
      // Yesterday's midnight, and the same time of day yesterday: as long after it as now is
      // after today's.
      const { rows: days } = await tx.execute<{
        since: Date | string;
        until: Date | string;
        yesterday: Date | string;
        sofar: Date | string;
      }>(sql`
        SELECT date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone} AS since,
               (date_trunc('day', now() AT TIME ZONE ${timezone}) + interval '1 day')
                 AT TIME ZONE ${timezone} AS until,
               (date_trunc('day', now() AT TIME ZONE ${timezone}) - interval '1 day')
                 AT TIME ZONE ${timezone} AS yesterday,
               (date_trunc('day', now() AT TIME ZONE ${timezone}) - interval '1 day')
                 AT TIME ZONE ${timezone}
                 + (now() - date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})
                 AS sofar`);
      const since = new Date(days[0]!.since);
      const until = new Date(days[0]!.until);
      const yesterday = tallyOf(
        await salesPeriodsIn(tx, shopId, timezone, {
          placedFrom: new Date(days[0]!.yesterday),
          placedBefore: new Date(days[0]!.sofar),
          interval: 'day',
        }),
      );
      const sales = tallyOf(
        await salesPeriodsIn(tx, shopId, timezone, {
          placedFrom: since,
          placedBefore: until,
          interval: 'day',
        }),
      );
      return {
        since,
        sales: { count: sales.orders, total: totalSales(sales) },
        salesYesterday: { count: yesterday.orders, total: totalSales(yesterday) },
        ...(await parcelsIn(tx, shopId, since, until)),
      };
    });
  }
}

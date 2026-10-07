import { shopProfile, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
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
      return {
        since,
        sales: { count: sales.orders, total: totalSales(sales) },
        salesYesterday: { count: yesterday.orders, total: totalSales(yesterday) },
        delivered: parcels('delivered'),
        returnedToOrigin: parcels('returned_to_origin'),
      };
    });
  }
}

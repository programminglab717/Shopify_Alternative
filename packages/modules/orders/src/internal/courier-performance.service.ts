import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ESTIMATED_CHARGE } from './parcel-estimates.js';

export const COURIER_PERFORMANCE_LIMITS = {
  /** The longest period asked for at once. */
  days: 366,
  /** Cities each courier lists at most, the most parcels first. */
  cities: 50,
} as const;

/** What parcels without a courier named are called: the shop's own riders, and walk-ins. */
const NO_COURIER = 'No courier named';

export interface CourierPerformanceInput {
  /** Parcels shipped at or after this… */
  shippedFrom: Date;
  /** …and before this. */
  shippedBefore: Date;
  /** Cities each courier lists, the most parcels first. */
  cities: number;
}

/** How a courier's parcels went, everywhere or in one city (SHP-08, ADR-384). */
export interface CourierPerformanceTally {
  shipped: number;
  delivered: number;
  /** Refused or undeliverable: on their way back, or back. */
  returned: number;
  /** Lost before reaching the customer; one refused and then lost stays returned. */
  lost: number;
  inTransit: number;
  /** The average days from shipped to delivered, to a tenth; null while none was delivered. */
  daysToDeliver: number | null;
  /**
   * Minor units: what statements charged for the parcels, else what rate cards say they are
   * likely to cost as they stand (ADR-383); and how many parcels either costs.
   */
  charges: bigint;
  parcelsCosted: number;
  /** Of {@link charges}, what rate cards estimate. */
  chargesEstimated: bigint;
}

export interface CourierPerformanceCity extends CourierPerformanceTally {
  /** The city as orders keep it, in the spelling most used. */
  city: string;
}

export interface CourierPerformanceRow extends CourierPerformanceTally {
  /** The courier as parcels name it, in the spelling most used; null for none named. */
  courier: string | null;
  title: string;
  cities: CourierPerformanceCity[];
}

type Row = {
  courier_key: string | null;
  courier_title: string | null;
  city_key: string | null;
  city_title: string | null;
  by_city: boolean;
  shipped: number;
  delivered: number;
  returned: number;
  lost: number;
  days: string | null;
  charges: string;
  costed: number;
  estimated: string;
};

/** Refused or undeliverable: on its way back, or back; as COD health counts it. */
const RETURNED = sql`(p.returning_at IS NOT NULL OR (p.status = 'returned' AND p.lost_at IS NULL))`;

function tallyOf(row: Row): CourierPerformanceTally {
  return {
    shipped: row.shipped,
    delivered: row.delivered,
    returned: row.returned,
    lost: row.lost,
    inTransit: row.shipped - row.delivered - row.returned - row.lost,
    daysToDeliver: row.days === null ? null : Math.round(Number(row.days) * 10) / 10,
    charges: BigInt(row.charges),
    parcelsCosted: row.costed,
    chargesEstimated: BigInt(row.estimated),
  };
}

/** How often parcels sent with a courier were delivered, of those that arrived anywhere. */
export interface DeliveryRateRow {
  /** The courier as parcels name it, lowercased and trimmed; null for the shop's whole. */
  courier: string | null;
  /** The city as orders have it, lowercased and trimmed; null for everywhere. */
  city: string | null;
  delivered: number;
  /** Delivered, returned or lost. */
  finished: number;
}

/**
 * Delivery rates of the parcels shipped since `since` (ADR-387), in the caller's transaction: for
 * each courier in each city, each courier everywhere, and the shop's whole. For courier rules
 * that weigh a courier's price with how often it delivers.
 */
export async function deliveryRatesIn(
  tx: Tx,
  shopId: string,
  since: Date,
): Promise<DeliveryRateRow[]> {
  const { rows } = await tx.execute<{
    courier: string | null;
    city: string | null;
    by_courier: boolean;
    by_city: boolean;
    delivered: number;
    finished: number;
  }>(sql`
    SELECT lower(nullif(btrim(f.tracking_company), '')) AS courier,
           lower(btrim(o.shipping_address->>'city')) AS city,
           GROUPING(lower(nullif(btrim(f.tracking_company), ''))) = 0 AS by_courier,
           GROUPING(lower(btrim(o.shipping_address->>'city'))) = 0 AS by_city,
           count(*) FILTER (WHERE f.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE f.status = 'delivered' OR f.returning_at IS NOT NULL
                              OR f.status = 'returned' OR f.lost_at IS NOT NULL)::int AS finished
      FROM orders.fulfillments f
      JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
     WHERE f.shop_id = ${shopId} AND f.shipped_at >= ${since}
     GROUP BY GROUPING SETS (
       (lower(nullif(btrim(f.tracking_company), '')), lower(btrim(o.shipping_address->>'city'))),
       (lower(nullif(btrim(f.tracking_company), ''))),
       ())`);
  // Parcels without a courier named, or by city without a city, count in the whole alone.
  return rows
    .filter((row) => (!row.by_courier || row.courier) && (!row.by_city || row.city))
    .map((row) => ({
      courier: row.courier,
      city: row.city,
      delivered: row.delivered,
      finished: row.finished,
    }));
}

/**
 * Couriers' performance (SHP-08, ADR-384): how each courier's parcels shipped in a period went,
 * everywhere and city by city: delivered, returned and lost, the days they took to deliver, and
 * what they cost, by statements else rate cards. Couriers go by the name parcels were shipped
 * with, as COD health's do; worked out from the parcels when asked, nothing stored.
 */
@Injectable()
export class CourierPerformanceService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    input: CourierPerformanceInput,
  ): Promise<MutationResult<CourierPerformanceRow[]>> {
    const span = input.shippedBefore.getTime() - input.shippedFrom.getTime();
    if (span <= 0) {
      return failOne(
        ['shippedBefore'],
        'INVALID',
        'Shipped before must be later than shipped from',
      );
    }
    if (span > COURIER_PERFORMANCE_LIMITS.days * 86_400_000) {
      return failOne(
        ['shippedBefore'],
        'INVALID',
        `Couriers' performance covers at most ${COURIER_PERFORMANCE_LIMITS.days} days at a time`,
      );
    }
    const cities = Math.min(Math.max(input.cities, 0), COURIER_PERFORMANCE_LIMITS.cities);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        WITH p AS (
          SELECT lower(nullif(btrim(f.tracking_company), '')) AS courier_key,
                 nullif(btrim(f.tracking_company), '') AS courier_name,
                 lower(btrim(o.shipping_address->>'city')) AS city_key,
                 btrim(o.shipping_address->>'city') AS city_name,
                 f.id, f.status, f.returning_at, f.lost_at, f.shipped_at, f.delivered_at,
                 coalesce(f.courier_charges, ${ESTIMATED_CHARGE}) AS charge,
                 CASE WHEN f.courier_charges IS NULL THEN ${ESTIMATED_CHARGE} END AS estimate
            FROM orders.fulfillments f
            JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
           WHERE f.shop_id = ${tenant.shopId}
             AND f.shipped_at >= ${input.shippedFrom} AND f.shipped_at < ${input.shippedBefore}
        )
        SELECT courier_key,
               mode() WITHIN GROUP (ORDER BY courier_name) AS courier_title,
               city_key,
               mode() WITHIN GROUP (ORDER BY city_name) AS city_title,
               GROUPING(city_key) = 0 AS by_city,
               count(*)::int AS shipped,
               count(*) FILTER (WHERE p.status = 'delivered')::int AS delivered,
               count(*) FILTER (WHERE ${RETURNED})::int AS returned,
               count(*) FILTER (WHERE p.lost_at IS NOT NULL AND p.returning_at IS NULL)::int
                 AS lost,
               avg(extract(epoch FROM p.delivered_at - p.shipped_at) / 86400)
                 FILTER (WHERE p.status = 'delivered')::text AS days,
               coalesce(sum(p.charge), 0)::text AS charges,
               count(p.charge)::int AS costed,
               coalesce(sum(p.estimate), 0)::text AS estimated
          FROM p
         GROUP BY GROUPING SETS ((courier_key), (courier_key, city_key))`);
      const couriers = new Map<string | null, CourierPerformanceRow>();
      for (const row of rows.filter((each) => !each.by_city)) {
        couriers.set(row.courier_key, {
          ...tallyOf(row),
          courier: row.courier_title,
          title: row.courier_title ?? NO_COURIER,
          cities: [],
        });
      }
      for (const row of rows.filter((each) => each.by_city)) {
        couriers.get(row.courier_key)?.cities.push({
          ...tallyOf(row),
          city: row.city_title ?? '',
        });
      }
      const byVolume = (a: { shipped: number }, b: { shipped: number }) => b.shipped - a.shipped;
      const report = [...couriers.values()].sort(
        (a, b) => byVolume(a, b) || a.title.localeCompare(b.title),
      );
      for (const courier of report) {
        courier.cities = courier.cities
          .sort((a, b) => byVolume(a, b) || a.city.localeCompare(b.city))
          .slice(0, cities);
      }
      return { ok: true, value: report };
    });
  }
}

import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { sessionDays } from './schema.js';

// The online store's sessions, as Shopify's analytics count them (ANL-02, ADR-180): each day's,
// in the shop's time zone, and how many of them added to the cart, reached checkout and placed
// an order. Storefronts count them in Valkey; the worker keeps each day's counts here.

export const SESSION_REPORT_LIMITS = {
  /** The longest period asked for at once, as the sales report's. */
  days: 366,
} as const;

/** How a report divides its period: days, weeks from Monday, or months, in the shop's time. */
export const SESSION_INTERVALS = ['day', 'week', 'month'] as const;
export type SessionIntervalValue = (typeof SESSION_INTERVALS)[number];

/** Sessions, and those of them that took each step on the way to an order. */
export interface SessionCounts {
  sessions: number;
  addedToCart: number;
  reachedCheckout: number;
  /** Those that placed an order. */
  converted: number;
}

export interface SessionPeriod extends SessionCounts {
  /** When the day, week or month starts, in the shop's time zone. */
  start: Date;
}

export interface SessionReport {
  totals: SessionCounts;
  /** Every day, week or month of the period, those without sessions included. */
  periods: SessionPeriod[];
}

type PeriodRow = {
  start: Date | string;
  sessions: number;
  added_to_cart: number;
  reached_checkout: number;
  converted: number;
};

@Injectable()
export class SessionDaysService {
  constructor(private readonly db: Database) {}

  /**
   * Keeps `day`'s counts so far, "2026-10-05" in the shop's time zone, in place of those kept
   * before: the storefronts' counts only grow through a day.
   */
  async keep(shopId: string, day: string, counts: SessionCounts): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx
        .insert(sessionDays)
        .values({ shopId, day, ...counts })
        .onConflictDoUpdate({
          target: [sessionDays.shopId, sessionDays.day],
          set: { ...counts, updatedAt: sql`now()` },
        }),
    );
  }

  /**
   * A period's sessions, for every day, week from Monday or month of it in the shop's time zone,
   * those without sessions included. Sessions are counted by the day: the days `from` and
   * `before` fall on count whole.
   */
  async report(
    tenant: TenantContext,
    input: { from: Date; before: Date; interval: SessionIntervalValue },
  ): Promise<MutationResult<SessionReport>> {
    const span = input.before.getTime() - input.from.getTime();
    if (span <= 0) return failOne(['before'], 'INVALID', 'Before must be later than from');
    if (span > SESSION_REPORT_LIMITS.days * 86_400_000) {
      return failOne(
        ['before'],
        'INVALID',
        `A report covers at most ${SESSION_REPORT_LIMITS.days} days at a time`,
      );
    }
    const { shopId } = tenant;
    const { from, before, interval } = input;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const first = sql`${from}::timestamptz AT TIME ZONE ${timezone}`;
      const last = sql`(${before}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone}`;
      const { rows } = await tx.execute<PeriodRow>(sql`
        WITH buckets AS (
          SELECT generate_series(date_trunc(${interval}, ${first}),
                                 date_trunc(${interval}, ${last}),
                                 ('1 ' || ${interval}::text)::interval) AS bucket
        ),
        counted AS (
          SELECT date_trunc(${interval}, d.day::timestamp) AS bucket,
                 sum(d.sessions)::int AS sessions, sum(d.added_to_cart)::int AS added_to_cart,
                 sum(d.reached_checkout)::int AS reached_checkout,
                 sum(d.converted)::int AS converted
            FROM online_store.session_days d
           WHERE d.shop_id = ${shopId} AND d.day >= (${first})::date AND d.day <= (${last})::date
           GROUP BY 1
        )
        SELECT b.bucket AT TIME ZONE ${timezone} AS start,
               coalesce(c.sessions, 0) AS sessions,
               coalesce(c.added_to_cart, 0) AS added_to_cart,
               coalesce(c.reached_checkout, 0) AS reached_checkout,
               coalesce(c.converted, 0) AS converted
          FROM buckets b LEFT JOIN counted c ON c.bucket = b.bucket
         ORDER BY b.bucket`);
      const periods = rows.map((row): SessionPeriod => ({
        start: new Date(row.start),
        sessions: row.sessions,
        addedToCart: row.added_to_cart,
        reachedCheckout: row.reached_checkout,
        converted: row.converted,
      }));
      const totals: SessionCounts = {
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        converted: 0,
      };
      for (const period of periods) {
        totals.sessions += period.sessions;
        totals.addedToCart += period.addedToCart;
        totals.reachedCheckout += period.reachedCheckout;
        totals.converted += period.converted;
      }
      return { ok: true, value: { totals, periods } };
    });
  }
}

/** The share of `counts`' sessions that placed an order, to four places; null without any. */
export function conversionRate(counts: SessionCounts): number | null {
  return counts.sessions > 0
    ? Math.round((counts.converted / counts.sessions) * 10_000) / 10_000
    : null;
}

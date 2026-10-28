import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { SESSION_REPORT_LIMITS } from './session-days.service.js';

// The online store's sessions by where they came from, the page they landed on and their device
// (ANL-02, ADR-884), as Shopify's sessions by referrer, landing page and device: each day's, in the
// shop's time zone, counted once a session as it began. Storefronts count them in Valkey; the
// worker keeps each day's counts here, as it keeps the sessions (ADR-180).

export const SESSION_ORIGIN_DIMENSIONS = ['source', 'landing_page', 'device'] as const;
export type SessionOriginDimension = (typeof SESSION_ORIGIN_DIMENSIONS)[number];

export const SESSION_ORIGIN_LIMITS = {
  /** Values of each a day kept by name; the rest together as {@link OTHER}. */
  kept: 100,
  /** Values a report gives at most, the most sessions first. */
  first: 50,
} as const;

/** What a day's values past the most kept are counted as. */
export const OTHER = '(other)';

export interface SessionOriginCount {
  value: string;
  sessions: number;
}

export interface SessionOriginsReport {
  /** The period's sessions counted by it: those whose first page said where they came from. */
  total: number;
  values: SessionOriginCount[];
}

@Injectable()
export class SessionOriginsService {
  constructor(private readonly db: Database) {}

  /**
   * Keeps `day`'s counts so far, "2026-10-05" in the shop's time zone, in place of those kept
   * before: of each, the 100 values with the most sessions by name, the rest as "(other)".
   */
  async keep(
    shopId: string,
    day: string,
    origins: Readonly<Record<SessionOriginDimension, Readonly<Record<string, number>>>>,
  ): Promise<void> {
    const rows: { dimension: string; value: string; sessions: number }[] = [];
    for (const dimension of SESSION_ORIGIN_DIMENSIONS) {
      const counted = Object.entries(origins[dimension] ?? {})
        .filter(
          ([value, sessions]) => value !== '' && Number.isSafeInteger(sessions) && sessions > 0,
        )
        .map(([value, sessions]) => ({ value: value.slice(0, 200), sessions }))
        .sort((a, b) => b.sessions - a.sessions || a.value.localeCompare(b.value));
      const kept = counted.slice(0, SESSION_ORIGIN_LIMITS.kept);
      const rest = counted
        .slice(SESSION_ORIGIN_LIMITS.kept)
        .reduce((sum, each) => sum + each.sessions, 0);
      for (const each of kept) rows.push({ dimension, ...each });
      if (rest > 0) rows.push({ dimension, value: OTHER, sessions: rest });
    }
    if (rows.length === 0) return;
    await this.db.tenant(shopId, async (tx) => {
      // The day's counts so far, in place of all kept before: a value may have fallen to "(other)".
      await tx.execute(sql`
        DELETE FROM online_store.session_origins WHERE shop_id = ${shopId} AND day = ${day}`);
      await tx.execute(sql`
        INSERT INTO online_store.session_origins (shop_id, day, dimension, value, sessions)
        VALUES ${sql.join(
          rows.map(
            (row) => sql`(${shopId}, ${day}, ${row.dimension}, ${row.value}, ${row.sessions})`,
          ),
          sql`, `,
        )}`);
    });
  }

  /**
   * A period's sessions by `by`, the most first, as the sessions are counted: by the day, the
   * days `from` and `before` fall on in the shop's time zone counting whole.
   */
  async report(
    tenant: TenantContext,
    input: { from: Date; before: Date; by: SessionOriginDimension; first?: number },
  ): Promise<MutationResult<SessionOriginsReport>> {
    const span = input.before.getTime() - input.from.getTime();
    if (span <= 0) return failOne(['before'], 'INVALID', 'Before must be later than from');
    if (span > SESSION_REPORT_LIMITS.days * 86_400_000) {
      return failOne(
        ['before'],
        'INVALID',
        `A report covers at most ${SESSION_REPORT_LIMITS.days} days at a time`,
      );
    }
    const first = Math.min(Math.max(input.first ?? 20, 1), SESSION_ORIGIN_LIMITS.first);
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      const firstDay = sql`(${input.from}::timestamptz AT TIME ZONE ${timezone})::date`;
      const lastDay = sql`((${input.before}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone})::date`;
      const { rows } = await tx.execute<{ value: string; sessions: number }>(sql`
        SELECT value, sum(sessions)::int AS sessions
          FROM online_store.session_origins
         WHERE shop_id = ${shopId} AND dimension = ${input.by}
           AND day >= ${firstDay} AND day <= ${lastDay}
         GROUP BY value
         ORDER BY sum(sessions) DESC, value`);
      // The most by name; those past them, and the days' own "(other)", together last.
      const named = rows.filter((row) => row.value !== OTHER);
      const values = named
        .slice(0, first)
        .map((row) => ({ value: row.value, sessions: row.sessions }));
      const rest =
        (rows.find((row) => row.value === OTHER)?.sessions ?? 0) +
        named.slice(first).reduce((sum, row) => sum + row.sessions, 0);
      if (rest > 0) values.push({ value: OTHER, sessions: rest });
      return {
        ok: true,
        value: { total: rows.reduce((sum, row) => sum + row.sessions, 0), values },
      };
    });
  }
}

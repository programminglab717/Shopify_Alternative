import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Where a shop's ads ran: Meta's apps, TikTok, Google, or anywhere else. */
export const AD_SPEND_PLATFORMS = ['meta', 'tiktok', 'google', 'other'] as const;
export type AdSpendPlatformValue = (typeof AD_SPEND_PLATFORMS)[number];

/**
 * Where a day's spend came from: typed by the shop, or pulled from Meta's Marketing API (ADR-564)
 * or TikTok's Business API (ADR-566), each for its own platform's spend alone.
 */
export const AD_SPEND_SOURCES = ['manual', 'meta_api', 'tiktok_api'] as const;
export type AdSpendSourceValue = (typeof AD_SPEND_SOURCES)[number];

export const AD_SPEND_LIMITS = {
  /** Days, platforms and campaigns at once. */
  entries: 400,
  campaign: 200,
  /** In minor units: Rs 1,000,000,000 a day. */
  amount: 100_000_000_000n,
  /** The longest span listed at once. */
  days: 366,
} as const;

/** What a shop spent on one platform's ads on a day, or on one campaign of them. */
export interface AdSpendEntry {
  platform: AdSpendPlatformValue;
  /** The day in the shop's time zone, `YYYY-MM-DD`. */
  day: string;
  /** As its links' `utm_campaign` names it; null for the platform's day as a whole. */
  campaign: string | null;
  /** In minor units of the shop's currency. */
  amount: bigint;
  source: AdSpendSourceValue;
}

/** One day's spend as given: an amount of zero or blank takes it away. */
export interface AdSpendInput {
  platform: AdSpendPlatformValue;
  day: string;
  campaign?: string | null;
  /** In major units, as "2499.50". */
  amount: string;
}

type EntryRow = {
  platform: AdSpendPlatformValue;
  day: string;
  campaign: string;
  amount: string;
  source: AdSpendSourceValue;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` as a calendar date it is, `YYYY-MM-DD`; null for anything else. */
function dayOf(day: string): string | null {
  if (!DAY.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : day;
}

/**
 * What a shop spends on its ads (MKT-12, ANL-03, ADR-553), day by day, by platform and, where it
 * says, by campaign as its links' `utm_campaign` names it, in its own currency as it paid: the
 * sales report takes it off the orders' profit and sets it against their sales. Recorded by those
 * who connect the shop's ad platforms, or pulled from Meta's Marketing API (ADR-564) or TikTok's
 * Business API (ADR-566) where the shop connected its account there; a day of none is no entry.
 */
@Injectable()
export class AdSpendService {
  constructor(private readonly db: Database) {}

  /**
   * Records each day's spend given, replacing what that platform's day, or campaign of it, had;
   * an amount of zero takes it away. All of them, or none. How many were given. What the shop
   * types is its own, pulled before or not (ADR-564): a campaign's day typed over one pulled from
   * Meta or TikTok stays as typed, and a platform's whole day typed takes the place of the
   * campaigns pulled for it, which would count twice beside it.
   */
  async set(
    tenant: TenantContext,
    entries: readonly AdSpendInput[],
    now: Date = new Date(),
  ): Promise<MutationResult<number>> {
    if (entries.length === 0) return failOne(['entries'], 'BLANK', 'Give at least one day');
    if (entries.length > AD_SPEND_LIMITS.entries) {
      return failOne(
        ['entries'],
        'TOO_MANY',
        `At most ${AD_SPEND_LIMITS.entries} days and campaigns at a time`,
      );
    }
    const check = new InputChecker();
    // A day ahead of now anywhere is not spent yet.
    const latest = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    const kept = new Map<string, Omit<AdSpendEntry, 'source'>>();
    entries.forEach((entry, index) => {
      const field = (name: string) => ['entries', String(index), name];
      if (!(AD_SPEND_PLATFORMS as readonly string[]).includes(entry.platform)) {
        check.add(field('platform'), 'INVALID', 'must be Meta, TikTok, Google or other');
        return;
      }
      const day = dayOf(entry.day);
      if (!day || day < '2020-01-01' || day > latest) {
        check.add(field('day'), 'INVALID', 'must be a day up to today, as 2026-10-17');
        return;
      }
      const campaign = check.text(field('campaign'), entry.campaign, {
        max: AD_SPEND_LIMITS.campaign,
      });
      const amount = check.price(field('amount'), entry.amount, tenant.currency, {
        required: true,
      });
      if (amount !== null && amount > AD_SPEND_LIMITS.amount) {
        check.add(field('amount'), 'INVALID', 'is more than a day of ads could cost');
        return;
      }
      if (amount === null) return;
      // Given twice, the last counts.
      kept.set(`${entry.platform}|${day}|${(campaign ?? '').toLowerCase()}`, {
        platform: entry.platform,
        day,
        campaign,
        amount,
      });
    });
    if (!check.ok) return fail(check.errors);

    await this.db.tenant(tenant.shopId, async (tx) => {
      for (const entry of kept.values()) {
        // Campaigns in any letter case are one, as the sales report has them.
        await tx.execute(sql`
          DELETE FROM marketing.ad_spend
           WHERE shop_id = ${tenant.shopId} AND platform = ${entry.platform}
             AND day = ${entry.day}::date AND lower(campaign) = ${(entry.campaign ?? '').toLowerCase()}`);
        if (entry.amount > 0n) {
          if (!entry.campaign) {
            await tx.execute(sql`
              DELETE FROM marketing.ad_spend
               WHERE shop_id = ${tenant.shopId} AND platform = ${entry.platform}
                 AND day = ${entry.day}::date AND source <> 'manual'`);
          }
          await tx.execute(sql`
            INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
            VALUES (${tenant.shopId}, ${entry.platform}, ${entry.day}::date,
                    ${entry.campaign ?? ''}, ${entry.amount}, 'manual')`);
        }
      }
    });
    return { ok: true, value: entries.length };
  }

  /** What the shop spent from `from` to `to`, both days included, latest first. */
  async list(
    tenant: TenantContext,
    from: string,
    to: string,
  ): Promise<MutationResult<AdSpendEntry[]>> {
    const first = dayOf(from);
    const last = dayOf(to);
    if (!first) return failOne(['from'], 'INVALID', 'must be a day, as 2026-10-01');
    if (!last || last < first) return failOne(['to'], 'INVALID', 'must be a day from the first on');
    const span = (Date.parse(last) - Date.parse(first)) / 86_400_000 + 1;
    if (span > AD_SPEND_LIMITS.days) {
      return failOne(
        ['to'],
        'INVALID',
        `Ad spend is listed ${AD_SPEND_LIMITS.days} days at a time`,
      );
    }
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<EntryRow>(sql`
        SELECT platform, to_char(day, 'YYYY-MM-DD') AS day, campaign, amount::text AS amount,
               source
          FROM marketing.ad_spend
         WHERE shop_id = ${tenant.shopId} AND day BETWEEN ${first}::date AND ${last}::date
         ORDER BY day DESC, platform, campaign`),
    );
    return {
      ok: true,
      value: rows.map((row) => ({
        platform: row.platform,
        day: row.day,
        campaign: row.campaign === '' ? null : row.campaign,
        amount: BigInt(row.amount),
        source: row.source,
      })),
    };
  }
}

/** What one of the shop's campaigns spent on a day, as its ad platform reports it (ADR-564). */
export interface PulledAdSpend {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Up to 200 characters. */
  campaign: string;
  /** In minor units of the shop's currency. */
  amount: bigint;
}

/**
 * Puts `pulled`, what `platform`'s API `source` now reports of the days `since` to `until`, both
 * included, in the place of what was pulled from it for those days before, in the caller's
 * transaction: Meta's Marketing API's (ADR-564), or TikTok's Business API's (ADR-566). A day or
 * campaign it no longer reports goes, as one of nothing does. The shop's own stay as it typed
 * them: a campaign's day it typed keeps what the platform says of that campaign out, and the
 * platform's whole day it typed keeps out every campaign of that day, which would count twice
 * beside it. The same campaign named twice is added up, as the sales report would. How many days
 * and campaigns were kept.
 */
export async function replacePulledAdSpendIn(
  tx: Tx,
  shopId: string,
  platform: AdSpendPlatformValue,
  source: Exclude<AdSpendSourceValue, 'manual'>,
  since: string,
  until: string,
  pulled: readonly PulledAdSpend[],
): Promise<number> {
  const { rows: typed } = await tx.execute<{ day: string; campaign: string }>(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, lower(campaign) AS campaign
      FROM marketing.ad_spend
     WHERE shop_id = ${shopId} AND platform = ${platform} AND source = 'manual'
       AND day BETWEEN ${since}::date AND ${until}::date`);
  const own = new Set(typed.map((row) => `${row.day}|${row.campaign}`));
  const wholeDays = new Set(typed.filter((row) => row.campaign === '').map((row) => row.day));
  // Campaigns in any letter case are one, as the sales report has them.
  const kept = new Map<string, PulledAdSpend>();
  for (const entry of pulled) {
    if (!dayOf(entry.day) || entry.day < since || entry.day > until) continue;
    const key = `${entry.day}|${entry.campaign.toLowerCase()}`;
    if (own.has(key) || wholeDays.has(entry.day)) continue;
    const before = kept.get(key);
    kept.set(key, before ? { ...before, amount: before.amount + entry.amount } : { ...entry });
  }
  const values = [...kept.values()].filter(
    (entry) => entry.amount > 0n && entry.amount <= AD_SPEND_LIMITS.amount,
  );
  await tx.execute(sql`
    DELETE FROM marketing.ad_spend
     WHERE shop_id = ${shopId} AND platform = ${platform} AND source = ${source}
       AND day BETWEEN ${since}::date AND ${until}::date`);
  for (let start = 0; start < values.length; start += 500) {
    const rows = values
      .slice(start, start + 500)
      .map(
        (entry) =>
          sql`(${shopId}, ${platform}, ${entry.day}::date, ${entry.campaign}, ${entry.amount}, ${source})`,
      );
    await tx.execute(sql`
      INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
      VALUES ${sql.join(rows, sql`, `)}`);
  }
  return values.length;
}

/** A period of the shop's days: those whose start, in `timezone`, is in it. */
export interface AdSpendPeriod {
  placedFrom: Date;
  placedBefore: Date;
  interval: 'day' | 'week' | 'month';
}

/**
 * What the shop spent on ads in each day, week or month of `period` that it spent anything in,
 * by when it starts, in the caller's transaction `tx`: for the sales report, whose orders count on
 * the day they were placed in the shop's time zone `timezone`.
 */
export async function adSpendByPeriodIn(
  tx: Tx,
  shopId: string,
  timezone: string,
  period: AdSpendPeriod,
): Promise<{ start: Date; amount: bigint }[]> {
  const { rows } = await tx.execute<{ start: Date | string; amount: string }>(sql`
    SELECT date_trunc(${period.interval}, day::timestamp) AT TIME ZONE ${timezone} AS start,
           sum(amount)::text AS amount
      FROM marketing.ad_spend
     WHERE shop_id = ${shopId}
       AND day::timestamp AT TIME ZONE ${timezone} >= ${period.placedFrom}
       AND day::timestamp AT TIME ZONE ${timezone} < ${period.placedBefore}
     GROUP BY 1`);
  return rows.map((row) => ({ start: new Date(row.start), amount: BigInt(row.amount) }));
}

/**
 * What the shop spent on each campaign it named in `period`, by the campaign in lower case, with
 * its spelling most used, in the caller's transaction `tx`.
 */
export async function adSpendByCampaignIn(
  tx: Tx,
  shopId: string,
  timezone: string,
  period: Omit<AdSpendPeriod, 'interval'>,
): Promise<Map<string, { title: string; amount: bigint }>> {
  const { rows } = await tx.execute<{ campaign: string; title: string; amount: string }>(sql`
    SELECT lower(campaign) AS campaign, mode() WITHIN GROUP (ORDER BY campaign) AS title,
           sum(amount)::text AS amount
      FROM marketing.ad_spend
     WHERE shop_id = ${shopId} AND campaign <> ''
       AND day::timestamp AT TIME ZONE ${timezone} >= ${period.placedFrom}
       AND day::timestamp AT TIME ZONE ${timezone} < ${period.placedBefore}
     GROUP BY 1`);
  return new Map(
    rows.map((row) => [row.campaign, { title: row.title, amount: BigInt(row.amount) }]),
  );
}

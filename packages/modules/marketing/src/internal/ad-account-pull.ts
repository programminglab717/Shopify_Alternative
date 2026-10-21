// A shop's ad account on a platform its spend is pulled from, as Hatti keeps it, and the pull:
// Meta's ad accounts (ADR-564), TikTok's advertiser accounts (ADR-566) and Google Ads accounts
// (ADR-678) alike, each platform's in a table of its own of the same columns. What a platform is asked, and how it answers, is its
// own client's.
import { shopProfile } from '@hatti/api';
import type { SecretBox } from '@hatti/crypto';
import { toDate, type Database, type Tx } from '@hatti/db';
import { exponentOf, isCurrencyCode } from '@hatti/money';
import { sql } from 'drizzle-orm';
import {
  AD_SPEND_LIMITS,
  replacePulledAdSpendIn,
  type AdSpendSourceValue,
  type PulledAdSpend,
} from './ad-spend.service.js';
import { dayIn } from './calendar.service.js';

/**
 * The days each pull covers, today in the shop's time zone among them: the last week, which the
 * platforms still revise; the last 30 the first time.
 */
export const AD_SPEND_PULL_DAYS = { sync: 7, backfill: 30 } as const;

/** How soon after the last the shop may have its spend pulled again. */
export const AD_SPEND_PULL_GAP_MS = 60_000;

/** A platform whose spend is pulled, and where its shops' accounts are kept. */
export interface AdAccountTable {
  platform: 'meta' | 'tiktok' | 'google';
  source: Exclude<AdSpendSourceValue, 'manual'>;
  /** In the marketing schema. */
  table: 'meta_ad_accounts' | 'tiktok_ad_accounts' | 'google_ads_accounts';
  /** Its column of the account's ID, and what a change of it is called in events and audits. */
  idColumn: 'ad_account_id' | 'advertiser_id' | 'customer_id';
  idField: 'adAccountId' | 'advertiserId' | 'customerId';
  /** What shops' sealed tokens are bound to, with the shop's ID: each opens for its shop alone. */
  sealing: 'meta-ads' | 'tiktok-ads' | 'google-ads';
}

/** An account as the platform shows it. */
export interface AdAccountFacts {
  name: string;
  /** What it bills in, "PKR". */
  currency: string;
  /** The time zone its days are reported in, "Asia/Karachi"; null when the platform gave none. */
  timezone: string | null;
}

/** What one campaign spent on a day, as the platform reports it. */
export interface CampaignDay {
  /** In the account's time zone, `YYYY-MM-DD`. */
  day: string;
  campaign: string;
  /** In the account's currency, as the platform writes it: "1234.56". */
  spend: string;
}

/** The account as kept: never its token. */
export interface AdAccountKept extends AdAccountFacts {
  accountId: string;
  /** The token's last four characters. */
  tokenHint: string;
  /** When its spend was last pulled; null before the first time. */
  lastSyncedAt: Date | null;
  /** Why the last pull failed; null when it went through. */
  lastError: string | null;
  updatedAt: Date;
}

/** How pulling the shop's spend went: how many days it covered and entries it kept, or why not. */
export type AdSpendPull =
  { ok: true; days: number; entries: number } | { ok: false; message: string };

/** What the platform reports of an account's campaigns' days, or why it did not. */
export type CampaignDaysOf = (
  accountId: string,
  token: string,
  since: string,
  until: string,
) => Promise<{ ok: true; value: readonly CampaignDay[] } | { ok: false; message: string }>;

/** An account's row, its ID column as `account_id`. */
export type AdAccountRow = {
  account_id: string;
  name: string;
  currency: string;
  timezone: string | null;
  access_token: string;
  token_hint: string;
  last_synced_at: string | Date | null;
  last_error: string | null;
  version: number;
  updated_at: string | Date;
};

/**
 * `spend`, a decimal the platform wrote in major units, in minor units of a currency with
 * `exponent` decimal places, rounded half up; null for anything else.
 */
export function spendMinor(spend: string, exponent: number): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(spend.trim());
  if (!match) return null;
  const [, whole = '0', fraction = ''] = match;
  const minor = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, '0'));
  return (fraction[exponent] ?? '0') >= '5' ? minor + 1n : minor;
}

/** What the shop's sealed token is bound to: it opens for that shop alone. */
function sealedFor(table: AdAccountTable, shopId: string): string {
  return `${table.sealing}:${shopId}`;
}

/** The day `days` after `day`, YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The table's name and ID column, from {@link AdAccountTable}'s fixed names alone. */
function namesOf(table: AdAccountTable) {
  return { table: sql.raw(`marketing.${table.table}`), id: sql.raw(table.idColumn) };
}

function columnsOf(table: AdAccountTable) {
  return sql.raw(
    `${table.idColumn} AS account_id, name, currency, timezone, access_token, token_hint, ` +
      'last_synced_at, last_error, version, updated_at',
  );
}

export async function adAccountIn(
  tx: Tx,
  table: AdAccountTable,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<AdAccountRow | null> {
  const { rows } = await tx.execute<AdAccountRow>(sql`
    SELECT ${columnsOf(table)} FROM ${namesOf(table).table}
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

export function adAccountKeptOf(row: AdAccountRow): AdAccountKept {
  return {
    accountId: row.account_id,
    name: row.name,
    currency: row.currency,
    timezone: row.timezone,
    tokenHint: row.token_hint,
    lastSyncedAt: row.last_synced_at === null ? null : toDate(row.last_synced_at),
    lastError: row.last_error,
    updatedAt: toDate(row.updated_at),
  };
}

/** What saving an account changed, and what it had before; null when nothing changed. */
export interface AdAccountSaved {
  /** `idField` and "accessToken", as each changed. */
  changed: string[];
  tokenHint: string;
  before: AdAccountRow | null;
}

/**
 * Keeps the shop's account `accountId` as the platform showed it, in place of any it had, with
 * `token` sealed for the shop alone, in the caller's transaction. Another account's spend is
 * pulled from its first 30 days; another token tries at once.
 */
export async function saveAdAccountIn(
  tx: Tx,
  box: SecretBox,
  table: AdAccountTable,
  shopId: string,
  accountId: string,
  facts: AdAccountFacts,
  token: string,
): Promise<AdAccountSaved | null> {
  const current = await adAccountIn(tx, table, shopId, { lock: true });
  const opened = current && box.decrypt(current.access_token, sealedFor(table, shopId)).toString();
  const changed = [
    ...(accountId !== current?.account_id ? [table.idField] : []),
    ...(token !== opened ? ['accessToken'] : []),
  ];
  if (current && changed.length === 0) return null;
  const sealed = box.encrypt(token, sealedFor(table, shopId));
  const tokenHint = token.slice(-4);
  const { name, currency, timezone } = facts;
  const { table: into, id } = namesOf(table);
  await tx.execute(sql`
    INSERT INTO ${into} (shop_id, ${id}, name, currency, timezone, access_token, token_hint)
    VALUES (${shopId}, ${accountId}, ${name}, ${currency}, ${timezone}, ${sealed}, ${tokenHint})
        ON CONFLICT (shop_id) DO UPDATE
               SET ${id} = excluded.${id}, name = excluded.name,
                   currency = excluded.currency, timezone = excluded.timezone,
                   access_token = excluded.access_token, token_hint = excluded.token_hint,
                   last_attempt_at = NULL, last_error = NULL,
                   last_synced_at = CASE
                     WHEN ${into}.${id} = excluded.${id} THEN ${into}.last_synced_at END,
                   version = ${into}.version + 1, updated_at = now()`);
  return { changed, tokenHint, before: current };
}

/** Forgets the shop's account and its token, in the caller's transaction: its ID, or null. */
export async function deleteAdAccountIn(
  tx: Tx,
  table: AdAccountTable,
  shopId: string,
): Promise<string | null> {
  const { table: name, id } = namesOf(table);
  const { rows } = await tx.execute<{ account_id: string }>(sql`
    DELETE FROM ${name} WHERE shop_id = ${shopId} RETURNING ${id} AS account_id`);
  return rows[0]?.account_id ?? null;
}

/**
 * The shops with an account connected whose spend was last asked for before `before`, or never,
 * those asked longest ago first: for the worker.
 */
export async function adAccountsDue(
  db: Database,
  table: AdAccountTable,
  before: Date,
  limit: number,
): Promise<string[]> {
  const { rows } = await db.system((tx) =>
    tx.execute<{ shop_id: string }>(sql`
      SELECT shop_id FROM ${namesOf(table).table}
       WHERE last_attempt_at IS NULL OR last_attempt_at < ${before.toISOString()}
       ORDER BY last_attempt_at NULLS FIRST, shop_id
       LIMIT ${limit}`),
  );
  return rows.map((row) => row.shop_id);
}

/**
 * Pulls the shop's spend at `at` from the platform, as `daysOf` asks it, in place of what was
 * pulled of those days before, as {@link replacePulledAdSpendIn} keeps it; what the platform says
 * when it refuses is kept for the shop to see, and the next round tries again. Null when the shop
 * has no account connected, or its spend was asked for under `gapMs` ago. A token or account
 * changed meanwhile is the next pull's.
 *
 * The platform is asked outside the shop's transactions, as it may take a while. It reports days
 * in the account's time zone, and each is kept as the shop's day of that date: a Pakistani shop's
 * account is in Pakistan's time, as its shop is, and one in another zone is not moved into the
 * shop's (its zone is kept, for the admin to show).
 */
export async function pullAdSpend(
  db: Database,
  box: SecretBox,
  table: AdAccountTable,
  daysOf: CampaignDaysOf,
  shopId: string,
  at: Date,
  gapMs: number,
): Promise<AdSpendPull | null> {
  const { table: name } = namesOf(table);
  const started = await db.tenant(shopId, async (tx) => {
    const { rows } = await tx.execute<AdAccountRow>(sql`
      UPDATE ${name} SET last_attempt_at = ${at.toISOString()}
       WHERE shop_id = ${shopId}
         AND (last_attempt_at IS NULL
              OR last_attempt_at <= ${new Date(at.getTime() - gapMs).toISOString()})
      RETURNING ${columnsOf(table)}`);
    const row = rows[0];
    return row && { row, timezone: (await shopProfile(tx, shopId)).timezone };
  });
  if (!started) return null;
  const { row, timezone } = started;
  const days = row.last_synced_at ? AD_SPEND_PULL_DAYS.sync : AD_SPEND_PULL_DAYS.backfill;
  const until = dayIn(timezone, at);
  const since = addDays(until, 1 - days);
  const token = box.decrypt(row.access_token, sealedFor(table, shopId)).toString('utf8');
  const spend = await daysOf(row.account_id, token, since, until);

  const exponent = isCurrencyCode(row.currency) ? exponentOf(row.currency) : 2;
  return db.tenant(shopId, async (tx) => {
    const { rows } = await tx.execute<{ version: number }>(sql`
      SELECT version FROM ${name} WHERE shop_id = ${shopId} FOR UPDATE`);
    if (rows[0]?.version !== row.version) {
      return { ok: false, message: 'The ad account changed while its spend was pulled' };
    }
    if (!spend.ok) {
      await tx.execute(sql`
        UPDATE ${name} SET last_error = ${spend.message.slice(0, 1_000)}
         WHERE shop_id = ${shopId}`);
      return { ok: false, message: spend.message };
    }
    const pulled: PulledAdSpend[] = [];
    for (const each of spend.value) {
      const amount = spendMinor(each.spend, exponent);
      if (amount === null) continue;
      pulled.push({
        day: each.day,
        campaign: Array.from(each.campaign.trim()).slice(0, AD_SPEND_LIMITS.campaign).join(''),
        amount,
      });
    }
    const entries = await replacePulledAdSpendIn(
      tx,
      shopId,
      table.platform,
      table.source,
      since,
      until,
      pulled,
    );
    await tx.execute(sql`
      UPDATE ${name} SET last_synced_at = ${at.toISOString()}, last_error = NULL
       WHERE shop_id = ${shopId}`);
    return { ok: true, days, entries };
  });
}

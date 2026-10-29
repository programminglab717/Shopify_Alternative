import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OnlineStoreEvents } from './events.js';

// Theme experiments (OS-22, ADR-866): a shop shows a share of its shoppers a draft of its theme,
// a new home page, other sections, an offer's banner, and the rest its live theme, each shopper
// keeping the theme first shown them. Its storefront counts each arm's sessions, and those of
// them that added to the cart, reached checkout and ordered, as its analytics count a day's
// (ADR-180); the worker keeps the counts here, says which theme sells better once it can tell,
// and ends an experiment whose draft sells clearly worse, so a shop never loses much to one.
// Each arm's revenue is counted too, from the orders its sessions placed at checkout (ADR-921),
// for a second verdict: whether the draft brings more or less money a session. An experiment may
// show up to three drafts, each its own share, arms b, c and d, each compared with the live
// theme's at a confidence kept as sure however many there are (ADR-931).

export const EXPERIMENT_LIMITS = {
  name: 100,
  share: { min: 1, max: 50 },
  /** The drafts one shows, each its own share of shoppers, the live theme's never less (ADR-931). */
  drafts: 3,
  days: { min: 1, max: 30 },
  /** Sessions each arm needs before the experiment says anything of it. */
  sessions: 200,
  /** Sessions each arm needs before the worker ends one whose draft sells worse. */
  guardrailSessions: 500,
} as const;

/**
 * How sure the experiment must be a draft sells better or worse: two-sided 95%, split among its
 * drafts as Bonferroni's correction does, so three drafts are no likelier to find one by chance
 * (ADR-931). By how many drafts it shows.
 */
const SURE: Record<number, number> = { 1: 1.96, 2: 2.241, 3: 2.394 };
/** How sure the worker must be a draft sells worse to end it: one-sided 99.5%, split likewise. */
const GUARDRAIL: Record<number, number> = { 1: -2.58, 2: -2.807, 3: -2.935 };

/** The arms: the live theme's, and each draft's in turn (ADR-931). */
export const EXPERIMENT_ARMS = ['a', 'b', 'c', 'd'] as const;
export type ExperimentArmName = (typeof EXPERIMENT_ARMS)[number];
export type DraftArmName = Exclude<ExperimentArmName, 'a'>;

/** The arms of an experiment showing `drafts` drafts: "a" and "b" for one. */
export function armsOf(drafts: number): ExperimentArmName[] {
  return EXPERIMENT_ARMS.slice(0, drafts + 1);
}

export type ExperimentEnd = 'staff' | 'time' | 'guardrail' | 'theme_changed';

/** An arm's sessions, and those of them that took each step. */
export interface ArmCounts {
  sessions: number;
  added_to_cart: number;
  reached_checkout: number;
  converted: number;
  /**
   * What its sessions' orders placed at checkout came to, in minor units of the shop's currency,
   * and the sum of each order's square, for the spread of revenue a session (ADR-921).
   */
  revenue: number;
  revenue_squares: number;
}

/** Each arm's counts: the live theme's, the first draft's, and the others' where it shows them. */
export interface ExperimentResults {
  a: ArmCounts;
  b: ArmCounts;
  c?: ArmCounts;
  d?: ArmCounts;
}

/** What an experiment says of its draft so far, by the share of each arm's sessions that ordered. */
export type ExperimentVerdict = 'too_early' | 'no_difference' | 'b_better' | 'b_worse';

export interface ThemeExperimentRecord {
  id: string;
  name: string;
  /** The first draft, arm b. */
  themeId: string;
  /** Every draft, arms b, c and d in turn (ADR-931): the first is `themeId`. */
  themeIds: string[];
  share: number;
  startedAt: Date;
  endsAt: Date;
  endedAt: Date | null;
  endedReason: ExperimentEnd | null;
  results: ExperimentResults;
  countedAt: Date | null;
}

export interface ThemeExperimentInput {
  name: string;
  themeId: string;
  /** Up to two drafts more, arms c and d (ADR-931). */
  otherThemeIds?: readonly string[];
  share: number;
  days: number;
}

const NO_COUNTS: ArmCounts = {
  sessions: 0,
  added_to_cart: 0,
  reached_checkout: 0,
  converted: 0,
  revenue: 0,
  revenue_squares: 0,
};

type ExperimentRow = {
  id: string;
  name: string;
  theme_id: string;
  other_theme_ids: string[] | null;
  share: number;
  started_at: Date | string;
  ends_at: Date | string;
  ended_at: Date | string | null;
  ended_reason: ExperimentEnd | null;
  results: Partial<ExperimentResults> | null;
  counted_at: Date | string | null;
};

const toRecord = (row: ExperimentRow): ThemeExperimentRecord => {
  const themeIds = [row.theme_id, ...(row.other_theme_ids ?? [])];
  const results = Object.fromEntries(
    armsOf(themeIds.length).map((arm) => [arm, { ...NO_COUNTS, ...row.results?.[arm] }]),
  ) as unknown as ExperimentResults;
  return {
    id: row.id,
    name: row.name,
    themeId: row.theme_id,
    themeIds,
    share: row.share,
    startedAt: toDate(row.started_at),
    endsAt: toDate(row.ends_at),
    endedAt: row.ended_at === null ? null : toDate(row.ended_at),
    endedReason: row.ended_reason,
    results,
    countedAt: row.counted_at === null ? null : toDate(row.counted_at),
  };
};

const COLUMNS = sql.raw(
  'id, name, theme_id, other_theme_ids::text[] AS other_theme_ids, share, started_at, ends_at, ' +
    'ended_at, ended_reason, results, counted_at',
);

/** The drafts' arms `results` has: b, and c and d where it shows them. */
export function draftArmsOf(results: ExperimentResults): DraftArmName[] {
  return (['b', 'c', 'd'] as const).filter((arm) => results[arm] !== undefined);
}

/**
 * A draft's share of sessions that ordered against the live theme's, as a two-proportion z
 * score: positive where it sells better. Null until each arm has sessions and some ordered. The
 * first draft's, unless `arm` names another (ADR-931).
 */
export function zScoreOf(results: ExperimentResults, arm: DraftArmName = 'b'): number | null {
  const { a } = results;
  const b = results[arm];
  if (!b) return null;
  if (a.sessions === 0 || b.sessions === 0) return null;
  const pooled = (a.converted + b.converted) / (a.sessions + b.sessions);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / a.sessions + 1 / b.sessions));
  if (spread === 0) return null;
  return (b.converted / b.sessions - a.converted / a.sessions) / spread;
}

/** What `z` says of a draft, once its arm and the live theme's have sessions enough. */
function verdictFrom(
  z: number | null,
  results: ExperimentResults,
  arm: DraftArmName,
): ExperimentVerdict {
  const sure = SURE[draftArmsOf(results).length] ?? SURE[1]!;
  if (
    z === null ||
    results.a.sessions < EXPERIMENT_LIMITS.sessions ||
    (results[arm]?.sessions ?? 0) < EXPERIMENT_LIMITS.sessions
  ) {
    return 'too_early';
  }
  if (z >= sure) return 'b_better';
  if (z <= -sure) return 'b_worse';
  return 'no_difference';
}

/**
 * What the experiment says of a draft, the first unless `arm` names another, once each arm has
 * sessions enough: "b_better" and "b_worse" say it of that draft.
 */
export function verdictOf(results: ExperimentResults, arm: DraftArmName = 'b'): ExperimentVerdict {
  return verdictFrom(zScoreOf(results, arm), results, arm);
}

/**
 * The draft's revenue a session against the live theme's (ADR-921), as Welch's t score, taken as
 * a z score with so many sessions: positive where it brings more. Each order counts as its
 * session's revenue, sessions without one as nothing. Null until each arm has two sessions and
 * its revenue some spread.
 */
export function revenueZScoreOf(
  results: ExperimentResults,
  arm: DraftArmName = 'b',
): number | null {
  const spreadOf = (counts: ArmCounts) => {
    const mean = counts.revenue / counts.sessions;
    return Math.max(
      0,
      (counts.revenue_squares - counts.sessions * mean * mean) / (counts.sessions - 1),
    );
  };
  const { a } = results;
  const b = results[arm];
  if (!b || a.sessions < 2 || b.sessions < 2) return null;
  const spread = Math.sqrt(spreadOf(a) / a.sessions + spreadOf(b) / b.sessions);
  if (!(spread > 0)) return null;
  return (b.revenue / b.sessions - a.revenue / a.sessions) / spread;
}

/** What the experiment says of a draft's revenue a session, once each arm has sessions enough. */
export function revenueVerdictOf(
  results: ExperimentResults,
  arm: DraftArmName = 'b',
): ExperimentVerdict {
  return verdictFrom(revenueZScoreOf(results, arm), results, arm);
}

/**
 * Whether a draft sells so clearly worse the worker ends the experiment: any of them, so a shop
 * never loses much to one (ADR-931).
 */
export function guardrailTripped(results: ExperimentResults): boolean {
  const arms = draftArmsOf(results);
  const limit = GUARDRAIL[arms.length] ?? GUARDRAIL[1]!;
  return arms.some((arm) => {
    const z = zScoreOf(results, arm);
    return (
      z !== null &&
      z <= limit &&
      results.a.sessions >= EXPERIMENT_LIMITS.guardrailSessions &&
      results[arm]!.sessions >= EXPERIMENT_LIMITS.guardrailSessions
    );
  });
}

/** The shop's running experiment, in the caller's transaction `tx`; null for none. */
export async function runningExperimentIn(
  tx: Tx,
  shopId: string,
): Promise<ThemeExperimentRecord | null> {
  const { rows } = await tx.execute<ExperimentRow>(sql`
    SELECT ${COLUMNS} FROM online_store.theme_experiments
     WHERE shop_id = ${shopId} AND ended_at IS NULL`);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Ends the shop's running experiment for `reason`, in the caller's transaction `tx`: any, or only
 * the one showing `themeId` among its drafts where it is given. Whether one ended.
 */
export async function endExperimentIn(
  tx: Tx,
  shopId: string,
  reason: ExperimentEnd,
  options: { themeId?: string; id?: string } = {},
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE online_store.theme_experiments SET ended_at = now(), ended_reason = ${reason}
     WHERE shop_id = ${shopId} AND ended_at IS NULL
       ${
         options.themeId
           ? sql`AND (theme_id = ${options.themeId}
                      OR ${options.themeId}::uuid = ANY (other_theme_ids))`
           : sql``
       }
       ${options.id ? sql`AND id = ${options.id}` : sql``}
    RETURNING id`);
  if (!rows[0]) return false;
  await appendEvent(tx, shopId, {
    type: OnlineStoreEvents.ThemeExperimentUpdated,
    aggregateType: 'theme_experiment',
    aggregateId: rows[0].id,
    payload: { ended: reason },
  });
  return true;
}

/** Keeps an experiment's counts as the worker took them, in the caller's transaction `tx`. */
export async function recordExperimentResultsIn(
  tx: Tx,
  shopId: string,
  id: string,
  results: ExperimentResults,
): Promise<void> {
  await tx.execute(sql`
    UPDATE online_store.theme_experiments
       SET results = ${JSON.stringify(results)}::jsonb, counted_at = now()
     WHERE shop_id = ${shopId} AND id = ${id}`);
}

const NOT_FOUND = 'No experiment of the shop has this ID';

/**
 * The shop's theme experiments (ADR-866), run by staff who change its themes: one at a time, of
 * a theme it hasn't published.
 */
@Injectable()
export class ThemeExperimentService {
  constructor(private readonly db: Database) {}

  /** Its experiments, the newest first, twenty at most. */
  async list(tenant: TenantContext): Promise<ThemeExperimentRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<ExperimentRow>(sql`
        SELECT ${COLUMNS} FROM online_store.theme_experiments
         WHERE shop_id = ${tenant.shopId}
         ORDER BY started_at DESC, id DESC LIMIT 20`),
    );
    return rows.map(toRecord);
  }

  async start(
    tenant: TenantContext,
    input: ThemeExperimentInput,
  ): Promise<MutationResult<ThemeExperimentRecord>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, {
      required: true,
      max: EXPERIMENT_LIMITS.name,
    });
    const { share, days } = EXPERIMENT_LIMITS;
    const drafts = [input.themeId, ...(input.otherThemeIds ?? [])];
    // Each draft its share, the live theme never less than any (ADR-931): 50% for one, 33% each
    // for two, 25% each for three.
    const most = Math.min(share.max, Math.floor(100 / (drafts.length + 1)));
    if (drafts.length > EXPERIMENT_LIMITS.drafts) {
      check.addMessage(
        ['input', 'otherThemeIds'],
        'TOO_MANY',
        `An experiment shows ${EXPERIMENT_LIMITS.drafts} drafts at most`,
      );
    } else if (new Set(drafts).size < drafts.length) {
      check.addMessage(['input', 'otherThemeIds'], 'INVALID', 'Each draft is shown once');
    }
    if (!Number.isInteger(input.share) || input.share < share.min || input.share > most) {
      check.add(
        ['input', 'share'],
        'INVALID',
        drafts.length > 1
          ? `must be a whole percent from ${share.min} to ${most} with ${drafts.length} drafts`
          : `must be a whole percent from ${share.min} to ${share.max}`,
      );
    }
    if (!Number.isInteger(input.days) || input.days < days.min || input.days > days.max) {
      check.add(['input', 'days'], 'INVALID', `must be from ${days.min} to ${days.max}`);
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: themes } = await tx.execute<{ id: string; role: string }>(sql`
        SELECT id, role FROM online_store.themes
         WHERE shop_id = ${tenant.shopId} AND id = ANY (${sql.param(drafts)}::uuid[])`);
      for (const [index, id] of drafts.entries()) {
        const field = index === 0 ? ['input', 'themeId'] : ['input', 'otherThemeIds'];
        const theme = themes.find((each) => each.id === id);
        if (!theme) return failOne(field, 'NOT_FOUND', 'Theme not found');
        if (theme.role === 'main') {
          return failOne(
            field,
            'INVALID',
            'The live theme is the one the experiment compares a draft with: pick a draft',
          );
        }
      }
      if (await runningExperimentIn(tx, tenant.shopId)) {
        return failOne(
          ['input', 'themeId'],
          'TAKEN',
          'An experiment is running: end it before starting another',
        );
      }
      const { rows } = await tx.execute<ExperimentRow>(sql`
        INSERT INTO online_store.theme_experiments
               (shop_id, name, theme_id, other_theme_ids, share, ends_at)
        VALUES (${tenant.shopId}, ${name}, ${input.themeId},
                ${sql.param(drafts.slice(1))}::uuid[], ${input.share},
                now() + make_interval(days => ${input.days}))
        RETURNING ${COLUMNS}`);
      const record = toRecord(rows[0]!);
      await appendEvent(tx, tenant.shopId, {
        type: OnlineStoreEvents.ThemeExperimentUpdated,
        aggregateType: 'theme_experiment',
        aggregateId: record.id,
        payload: {},
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'theme_experiment.started',
        subjectType: 'theme',
        subjectId: input.themeId,
        ...actorColumnsOf(tenant.actor),
        details: { name, share: input.share, days: input.days, drafts: drafts.length },
      });
      return { ok: true, value: record };
    });
  }

  /** Ends a running experiment: every shopper sees the live theme again. */
  async end(tenant: TenantContext, id: string): Promise<MutationResult<ThemeExperimentRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (!(await endExperimentIn(tx, tenant.shopId, 'staff', { id }))) {
        return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      }
      const { rows } = await tx.execute<ExperimentRow>(sql`
        SELECT ${COLUMNS} FROM online_store.theme_experiments
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const record = toRecord(rows[0]!);
      await recordAudit(tx, tenant.shopId, {
        action: 'theme_experiment.ended',
        subjectType: 'theme',
        subjectId: record.themeId,
        ...actorColumnsOf(tenant.actor),
        details: { name: record.name },
      });
      return { ok: true, value: record };
    });
  }
}

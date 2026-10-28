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

export const EXPERIMENT_LIMITS = {
  name: 100,
  share: { min: 1, max: 50 },
  days: { min: 1, max: 30 },
  /** Sessions each arm needs before the experiment says anything of it. */
  sessions: 200,
  /** Sessions each arm needs before the worker ends one whose draft sells worse. */
  guardrailSessions: 500,
} as const;

/** How sure the experiment must be its draft sells better or worse: two-sided 95%. */
const SURE = 1.96;
/** How sure the worker must be its draft sells worse to end it: one-sided 99.5%. */
const GUARDRAIL = -2.58;

export type ExperimentEnd = 'staff' | 'time' | 'guardrail' | 'theme_changed';

/** An arm's sessions, and those of them that took each step. */
export interface ArmCounts {
  sessions: number;
  added_to_cart: number;
  reached_checkout: number;
  converted: number;
}

export interface ExperimentResults {
  a: ArmCounts;
  b: ArmCounts;
}

/** What an experiment says of its draft so far, by the share of each arm's sessions that ordered. */
export type ExperimentVerdict = 'too_early' | 'no_difference' | 'b_better' | 'b_worse';

export interface ThemeExperimentRecord {
  id: string;
  name: string;
  themeId: string;
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
  share: number;
  days: number;
}

const NO_COUNTS: ArmCounts = { sessions: 0, added_to_cart: 0, reached_checkout: 0, converted: 0 };

type ExperimentRow = {
  id: string;
  name: string;
  theme_id: string;
  share: number;
  started_at: Date | string;
  ends_at: Date | string;
  ended_at: Date | string | null;
  ended_reason: ExperimentEnd | null;
  results: Partial<ExperimentResults> | null;
  counted_at: Date | string | null;
};

const toRecord = (row: ExperimentRow): ThemeExperimentRecord => ({
  id: row.id,
  name: row.name,
  themeId: row.theme_id,
  share: row.share,
  startedAt: toDate(row.started_at),
  endsAt: toDate(row.ends_at),
  endedAt: row.ended_at === null ? null : toDate(row.ended_at),
  endedReason: row.ended_reason,
  results: { a: { ...NO_COUNTS, ...row.results?.a }, b: { ...NO_COUNTS, ...row.results?.b } },
  countedAt: row.counted_at === null ? null : toDate(row.counted_at),
});

const COLUMNS = sql.raw(
  'id, name, theme_id, share, started_at, ends_at, ended_at, ended_reason, results, counted_at',
);

/**
 * The draft's share of sessions that ordered against the live theme's, as a two-proportion z
 * score: positive where it sells better. Null until each arm has sessions and some ordered.
 */
export function zScoreOf(results: ExperimentResults): number | null {
  const { a, b } = results;
  if (a.sessions === 0 || b.sessions === 0) return null;
  const pooled = (a.converted + b.converted) / (a.sessions + b.sessions);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / a.sessions + 1 / b.sessions));
  if (spread === 0) return null;
  return (b.converted / b.sessions - a.converted / a.sessions) / spread;
}

/** What the experiment says of its draft, once each arm has sessions enough. */
export function verdictOf(results: ExperimentResults): ExperimentVerdict {
  const z = zScoreOf(results);
  if (
    z === null ||
    results.a.sessions < EXPERIMENT_LIMITS.sessions ||
    results.b.sessions < EXPERIMENT_LIMITS.sessions
  ) {
    return 'too_early';
  }
  if (z >= SURE) return 'b_better';
  if (z <= -SURE) return 'b_worse';
  return 'no_difference';
}

/** Whether the draft sells so clearly worse the worker ends the experiment. */
export function guardrailTripped(results: ExperimentResults): boolean {
  const z = zScoreOf(results);
  return (
    z !== null &&
    z <= GUARDRAIL &&
    results.a.sessions >= EXPERIMENT_LIMITS.guardrailSessions &&
    results.b.sessions >= EXPERIMENT_LIMITS.guardrailSessions
  );
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
 * the one showing `themeId` where it is given. Whether one ended.
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
       ${options.themeId ? sql`AND theme_id = ${options.themeId}` : sql``}
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
    if (!Number.isInteger(input.share) || input.share < share.min || input.share > share.max) {
      check.add(
        ['input', 'share'],
        'INVALID',
        `must be a whole percent from ${share.min} to ${share.max}`,
      );
    }
    if (!Number.isInteger(input.days) || input.days < days.min || input.days > days.max) {
      check.add(['input', 'days'], 'INVALID', `must be from ${days.min} to ${days.max}`);
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: themes } = await tx.execute<{ role: string }>(sql`
        SELECT role FROM online_store.themes
         WHERE shop_id = ${tenant.shopId} AND id = ${input.themeId}`);
      if (!themes[0]) return failOne(['input', 'themeId'], 'NOT_FOUND', 'Theme not found');
      if (themes[0].role === 'main') {
        return failOne(
          ['input', 'themeId'],
          'INVALID',
          'The live theme is the one the experiment compares a draft with: pick a draft',
        );
      }
      if (await runningExperimentIn(tx, tenant.shopId)) {
        return failOne(
          ['input', 'themeId'],
          'TAKEN',
          'An experiment is running: end it before starting another',
        );
      }
      const { rows } = await tx.execute<ExperimentRow>(sql`
        INSERT INTO online_store.theme_experiments (shop_id, name, theme_id, share, ends_at)
        VALUES (${tenant.shopId}, ${name}, ${input.themeId}, ${input.share},
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
        details: { name, share: input.share, days: input.days },
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

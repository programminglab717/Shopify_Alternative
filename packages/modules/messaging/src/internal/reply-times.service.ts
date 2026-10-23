import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** The longest period reported at once: a year. */
export const REPLY_TIMES_MAX_DAYS = 366;

/** How long customers waited for answers, of the shop or of one who answered (ADR-763). */
export interface ReplyTimesFigures {
  /** Answers to a customer who waited. */
  answered: number;
  /** The middle of their waits, in seconds; null without answers. */
  medianWaitSeconds: number | null;
  /** Of them, those within the shop's reply target; null while it sets none. */
  withinTarget: number | null;
}

export interface ReplyTimesRow extends ReplyTimesFigures {
  actor: { kind: 'staff' | 'app'; id: string };
}

export interface ReplyTimesReport extends ReplyTimesFigures {
  replyTargetMinutes: number | null;
  /** Each who answered: those who answered most first. */
  byActor: ReplyTimesRow[];
}

type Row = {
  actor_kind: 'staff' | 'app' | null;
  actor_id: string | null;
  answered: number;
  median_seconds: number | null;
  within_target: number | null;
};

/**
 * The inbox's reply times (MSG-06, ADR-763): of the answers given over a period to customers who
 * waited on WhatsApp, how many, the middle of their waits, and how many came within the shop's
 * reply target; for the shop and for each member of staff or app who answered. Worked out when
 * asked, from the answers kept as they are sent.
 */
@Injectable()
export class ReplyTimesService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    period: { from: Date; before: Date },
  ): Promise<MutationResult<ReplyTimesReport>> {
    const { from, before } = period;
    if (before.getTime() <= from.getTime()) {
      return failOne(['before'], 'INVALID', 'The period must end after it begins');
    }
    if (before.getTime() - from.getTime() > REPLY_TIMES_MAX_DAYS * 86_400_000) {
      return failOne(['from'], 'INVALID', `A period is at most ${REPLY_TIMES_MAX_DAYS} days`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const settings = await tx.execute<{ reply_target_minutes: number | null }>(sql`
        SELECT reply_target_minutes FROM messaging.settings WHERE shop_id = ${tenant.shopId}`);
      const target = settings.rows[0]?.reply_target_minutes ?? null;
      const waited = sql`extract(epoch FROM a.answered_at - a.waited_from)`;
      // One row for the shop (no actor), one for each who answered, at once.
      const { rows } = await tx.execute<Row>(sql`
        SELECT a.actor_kind, a.actor_id, count(*)::int AS answered,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${waited}))::int AS median_seconds,
               ${
                 target === null
                   ? sql`NULL::int`
                   : sql`(count(*) FILTER (WHERE ${waited} <= ${target * 60}))::int`
               } AS within_target
          FROM messaging.conversation_answers a
         WHERE a.shop_id = ${tenant.shopId}
           AND a.answered_at >= ${from.toISOString()}::timestamptz
           AND a.answered_at < ${before.toISOString()}::timestamptz
         GROUP BY GROUPING SETS ((), (a.actor_kind, a.actor_id))
         ORDER BY answered DESC, a.actor_kind, a.actor_id`);
      const shop = rows.find((row) => row.actor_kind === null);
      const figures = (row: Row | undefined): ReplyTimesFigures => ({
        answered: row?.answered ?? 0,
        medianWaitSeconds: row?.median_seconds ?? null,
        withinTarget: target === null ? null : (row?.within_target ?? 0),
      });
      return {
        ok: true as const,
        value: {
          ...figures(shop),
          replyTargetMinutes: target,
          byActor: rows
            .filter((row) => row.actor_kind !== null)
            .map((row) => ({
              actor: { kind: row.actor_kind!, id: row.actor_id! },
              ...figures(row),
            })),
        },
      };
    });
  }
}

import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PLANS, type PlanCode } from './plans.js';

/** Pakistan's offset from UTC, the same all year: credits come back at its midnight. */
const PKT_OFFSET_MS = 5 * 3_600_000;

/** The month of `at` in Pakistan's time: when it began and when the next begins. */
export function creditMonth(at: Date): { start: Date; next: Date } {
  const local = new Date(at.getTime() + PKT_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1) - PKT_OFFSET_MS),
    next: new Date(Date.UTC(year, month + 1, 1) - PKT_OFFSET_MS),
  };
}

/**
 * Each shop's AI credits (BIL-01, ADR-533): as many a month as its plan includes, each spent on
 * a draft the AI gave, counted from the start of the month in Pakistan's time.
 */
@Injectable()
export class AiCreditsService extends AiCredits {
  constructor(private readonly db: Database) {
    super();
  }

  async balanceOf(shopId: string, at: Date = new Date()): Promise<AiCreditBalance> {
    const { start, next } = creditMonth(at);
    const { plan, used } = await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ plan: PlanCode | null; used: number }>(sql`
        SELECT (SELECT plan FROM billing.subscriptions WHERE shop_id = ${shopId}) AS plan,
               (SELECT count(*)::int FROM billing.ai_credit_uses
                 WHERE shop_id = ${shopId} AND used_at >= ${start.toISOString()}
                   AND used_at < ${next.toISOString()}) AS used`);
      return rows[0]!;
    });
    const chosen = PLANS[plan ?? 'free'];
    return {
      perMonth: chosen.aiCredits,
      used,
      left: Math.max(0, chosen.aiCredits - used),
      plan: chosen.name,
      renewsAt: next,
    };
  }

  async spend(shopId: string, use: AiCreditUse, at: Date = new Date()): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO billing.ai_credit_uses (shop_id, use, used_at)
        VALUES (${shopId}, ${use}, ${at.toISOString()})`),
    );
  }
}

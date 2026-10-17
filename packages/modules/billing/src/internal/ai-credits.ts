import {
  AiCredits,
  actorColumnsOf,
  failOne,
  type AiCreditBalance,
  type AiCreditUse,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { formatMoney, money } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { balanceIn, walletEntryIn } from './credits.js';
import { BILLING_CURRENCY, PLANS, type PlanCode } from './plans.js';

/** Pakistan's offset from UTC, the same all year: credits come back at its midnight. */
const PKT_OFFSET_MS = 5 * 3_600_000;

/**
 * The AI credits a shop buys (ADR-539): a hundred at a time, paid from its message credit, up to
 * ten packs at once.
 */
export const AI_CREDIT_PACK = {
  credits: 100,
  /** Paisa: Rs 500. */
  price: 500_00n,
  most: 10,
} as const;

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
 * a draft the AI gave, counted from the start of the month in Pakistan's time; and those it buys,
 * paid from its message credit, which last until spent, the month's own being spent first
 * (ADR-539).
 */
@Injectable()
export class AiCreditsService extends AiCredits {
  constructor(private readonly db: Database) {
    super();
  }

  async balanceOf(shopId: string, at: Date = new Date()): Promise<AiCreditBalance> {
    return this.db.tenant(shopId, (tx) => balanceOfIn(tx, shopId, at));
  }

  async spend(shopId: string, use: AiCreditUse, at: Date = new Date()): Promise<void> {
    await this.db.tenant(shopId, async (tx) => {
      // One draft at a time spends the shop's credits: the next sees what this one spent.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai_credits:${shopId}`}))`);
      const balance = await balanceOfIn(tx, shopId, at);
      const fromPack = balance.used >= balance.perMonth && balance.bought > 0;
      await tx.execute(sql`
        INSERT INTO billing.ai_credit_uses (shop_id, use, used_at, from_pack)
        VALUES (${shopId}, ${use}, ${at.toISOString()}, ${fromPack})`);
    });
  }

  /**
   * Buys `packs` of AI credits for the shop, paid at once from its message credit, which must
   * hold their price. Its credits after. The owner alone, as the resolver checks.
   */
  async buy(
    tenant: TenantContext,
    packs: number,
    at: Date = new Date(),
  ): Promise<MutationResult<AiCreditBalance>> {
    if (!Number.isInteger(packs) || packs < 1 || packs > AI_CREDIT_PACK.most) {
      return failOne(
        ['packs'],
        'INVALID',
        `AI credits are bought 1 to ${AI_CREDIT_PACK.most} packs of ${AI_CREDIT_PACK.credits} at a time`,
      );
    }
    const { shopId } = tenant;
    const credits = packs * AI_CREDIT_PACK.credits;
    const price = BigInt(packs) * AI_CREDIT_PACK.price;
    return this.db.tenant(shopId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai_credits:${shopId}`}))`);
      const held = await balanceIn(tx, shopId);
      if (held < price) {
        return failOne<AiCreditBalance>(
          ['packs'],
          'INSUFFICIENT_FUNDS',
          `${credits} AI credits cost ${rupees(price)} of the shop's message credit, which has ` +
            `${rupees(held)}: buy credit first`,
        );
      }
      await tx.execute(sql`
        INSERT INTO billing.ai_credit_packs (shop_id, credits, price, bought_at)
        VALUES (${shopId}, ${credits}, ${price}, ${at.toISOString()})`);
      await walletEntryIn(tx, shopId, {
        kind: 'ai_credits',
        amount: -price,
        note: `${credits} AI credits`,
      });
      await recordAudit(tx, shopId, {
        action: 'billing.ai_credits_bought',
        subjectType: 'shop',
        subjectId: shopId,
        ...actorColumnsOf(tenant.actor),
        details: { credits, price: price.toString() },
      });
      return { ok: true, value: await balanceOfIn(tx, shopId, at) };
    });
  }
}

async function balanceOfIn(tx: Tx, shopId: string, at: Date): Promise<AiCreditBalance> {
  const { start, next } = creditMonth(at);
  const { rows } = await tx.execute<{ plan: PlanCode | null; used: number; bought: number }>(sql`
    SELECT (SELECT plan FROM billing.subscriptions WHERE shop_id = ${shopId}) AS plan,
           (SELECT count(*)::int FROM billing.ai_credit_uses
             WHERE shop_id = ${shopId} AND NOT from_pack
               AND used_at >= ${start.toISOString()} AND used_at < ${next.toISOString()}) AS used,
           (SELECT coalesce(sum(credits), 0)::int FROM billing.ai_credit_packs
             WHERE shop_id = ${shopId})
             - (SELECT count(*)::int FROM billing.ai_credit_uses
                 WHERE shop_id = ${shopId} AND from_pack) AS bought`);
  const { plan, used, bought } = rows[0]!;
  const chosen = PLANS[plan ?? 'free'];
  return {
    perMonth: chosen.aiCredits,
    used,
    bought: Math.max(0, bought),
    left: Math.max(0, chosen.aiCredits - used) + Math.max(0, bought),
    plan: chosen.name,
    renewsAt: next,
  };
}

function rupees(amount: bigint): string {
  return formatMoney(money(amount, BILLING_CURRENCY));
}

import { randomInt } from 'node:crypto';
import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * A shop's referral programme (MKT-07, ADR-807): what each side is given, in minor units, by
 * default and within bounds; how long it lasts; and how many a customer may be rewarded for in a
 * month, so that one who finds a way past the checks gains little.
 */
export const REFERRALS = {
  referrerCredit: { default: 200_00n, min: 10_00n, max: 10_000_00n },
  friendCredit: { default: 200_00n, min: 0n, max: 10_000_00n },
  days: { default: 90, min: 7, max: 365 },
  minimumOrder: { default: 0n, min: 0n, max: 1_000_000_00n },
  perMonth: 10,
} as const;

/** Letters and digits a code is made of: none mistaken for another, as O for 0. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Why a referral was not rewarded (ADR-807). */
export const REFERRAL_REFUSALS = [
  /** The order was the referrer's own. */
  'own_code',
  /** The friend had ordered from the shop before. */
  'not_first_order',
  /** The friend ordered from a device the referrer ordered from: their address and browser. */
  'same_device',
  /** The friend's order went where one of the referrer's went. */
  'same_address',
  /** The referrer has had no order delivered and paid themselves. */
  'referrer_unproven',
  /** The referrer was rewarded as often as a month allows. */
  'monthly_limit',
  /** The friend's goods came to less than the programme asks. */
  'below_minimum',
] as const;
export type ReferralRefusal = (typeof REFERRAL_REFUSALS)[number];

/** The shop's referral programme, as the Admin API shows it. */
export interface ReferralProgramRecord {
  enabled: boolean;
  referrerCredit: bigint;
  friendCredit: bigint;
  creditDays: number;
  minimumOrder: bigint;
  /** When the shop last changed it; null for one never set. */
  updatedAt: Date | null;
}

export interface ReferralProgramInput {
  enabled?: boolean | null;
  /** Amounts in the shop's currency's major units, as "200". */
  referrerCredit?: string | null;
  friendCredit?: string | null;
  creditDays?: number | null;
  minimumOrder?: string | null;
}

/** A friend's order a customer's code brought, and what became of it. */
export interface ReferralRecord {
  orderId: string;
  referrerId: string;
  friendId: string;
  outcome: 'rewarded' | 'refused';
  reason: ReferralRefusal | null;
  referrerCredit: bigint;
  friendCredit: bigint;
  createdAt: Date;
}

type ProgramRow = {
  enabled: boolean;
  referrer_credit: string;
  friend_credit: string;
  credit_days: number;
  minimum_order: string;
  updated_at: string | Date;
};

const recordOf = (row: ProgramRow | undefined): ReferralProgramRecord => ({
  enabled: row?.enabled ?? false,
  referrerCredit: row ? BigInt(row.referrer_credit) : REFERRALS.referrerCredit.default,
  friendCredit: row ? BigInt(row.friend_credit) : REFERRALS.friendCredit.default,
  creditDays: row?.credit_days ?? REFERRALS.days.default,
  minimumOrder: row ? BigInt(row.minimum_order) : REFERRALS.minimumOrder.default,
  updatedAt: row ? toDate(row.updated_at) : null,
});

/**
 * A shop's referral programme (MKT-07, ADR-807): each customer's code, the programme's credit,
 * and the referrals its codes brought. Changing it is audited; turning it on needs a plan with
 * loyalty, as cashback does (ADR-523).
 */
@Injectable()
export class ReferralProgramService {
  constructor(
    private readonly db: Database,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  /** The shop's programme, as set, or off where it never was. */
  async get(tenant: TenantContext): Promise<ReferralProgramRecord> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      recordOf(await programRowIn(tx, tenant.shopId)),
    );
  }

  /** Changes the shop's programme: amounts and days within their bounds. */
  async update(
    tenant: TenantContext,
    input: ReferralProgramInput,
  ): Promise<MutationResult<ReferralProgramRecord>> {
    const current = await this.get(tenant);
    const check = new InputChecker();
    const amount = (
      name: 'referrerCredit' | 'friendCredit' | 'minimumOrder',
      bounds: { min: bigint; max: bigint },
      words: string,
    ): bigint => {
      const value = input[name];
      if (value === undefined || value === null) return current[name];
      const parsed = check.price(['input', name], value, tenant.currency, { required: true });
      if (parsed === null) return current[name];
      if (parsed < bounds.min || parsed > bounds.max) {
        check.addMessage(['input', name], 'INVALID', words);
        return current[name];
      }
      return parsed;
    };
    const referrerCredit = amount(
      'referrerCredit',
      REFERRALS.referrerCredit,
      'Give the referrer between Rs 10 and Rs 10,000 in store credit',
    );
    const friendCredit = amount(
      'friendCredit',
      REFERRALS.friendCredit,
      'Give the friend up to Rs 10,000 in store credit',
    );
    const minimumOrder = amount(
      'minimumOrder',
      REFERRALS.minimumOrder,
      "A friend's order may ask for up to Rs 1,000,000",
    );
    let creditDays = current.creditDays;
    if (input.creditDays !== undefined && input.creditDays !== null) {
      if (
        !Number.isInteger(input.creditDays) ||
        input.creditDays < REFERRALS.days.min ||
        input.creditDays > REFERRALS.days.max
      ) {
        check.addMessage(
          ['input', 'creditDays'],
          'INVALID',
          `The credit lasts between ${REFERRALS.days.min} and ${REFERRALS.days.max} days`,
        );
      } else {
        creditDays = input.creditDays;
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const enabled = input.enabled ?? current.enabled;
    if (enabled && !current.enabled) {
      // A plan without loyalty turns none on; one on before stays on (ADR-523).
      const plan = await this.allowance?.excludes(tenant.shopId, 'loyalty');
      if (plan) {
        return failOne(
          ['input', 'enabled'],
          'INVALID',
          planFeatureMessage(plan, 'referrals', 'turn them on'),
        );
      }
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ProgramRow>(sql`
        INSERT INTO messaging.referral_programs
               (shop_id, enabled, referrer_credit, friend_credit, credit_days, minimum_order)
        VALUES (${tenant.shopId}, ${enabled}, ${referrerCredit}, ${friendCredit}, ${creditDays},
                ${minimumOrder})
        ON CONFLICT (shop_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, referrer_credit = EXCLUDED.referrer_credit,
               friend_credit = EXCLUDED.friend_credit, credit_days = EXCLUDED.credit_days,
               minimum_order = EXCLUDED.minimum_order, updated_at = now()
        RETURNING enabled, referrer_credit::text, friend_credit::text, credit_days,
                  minimum_order::text, updated_at`);
      await recordAudit(tx, tenant.shopId, {
        action: 'referral_program.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: {
          enabled,
          referrerCredit: referrerCredit.toString(),
          friendCredit: friendCredit.toString(),
          creditDays,
          minimumOrder: minimumOrder.toString(),
        },
      });
      return { ok: true, value: recordOf(rows[0]) };
    });
  }

  /** Customer `customerId`'s code, made the first time it is asked for; null for no customer. */
  async codeOf(shopId: string, customerId: string): Promise<string | null> {
    return this.db.tenant(shopId, (tx) => referralCodeIn(tx, shopId, customerId));
  }

  /** The referrals the shop's codes brought, latest first. */
  async referrals(tenant: TenantContext, first = 50): Promise<ReferralRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{
        order_id: string;
        referrer_id: string;
        friend_id: string;
        outcome: 'rewarded' | 'refused';
        reason: ReferralRefusal | null;
        referrer_credit: string;
        friend_credit: string;
        created_at: string | Date;
      }>(sql`
        SELECT order_id, referrer_id, friend_id, outcome, reason, referrer_credit::text,
               friend_credit::text, created_at
          FROM messaging.referrals
         WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, order_id
         LIMIT ${Math.min(Math.max(first, 1), 250)}`),
    );
    return rows.map((row) => ({
      orderId: row.order_id,
      referrerId: row.referrer_id,
      friendId: row.friend_id,
      outcome: row.outcome,
      reason: row.reason,
      referrerCredit: BigInt(row.referrer_credit),
      friendCredit: BigInt(row.friend_credit),
      createdAt: toDate(row.created_at),
    }));
  }
}

async function programRowIn(tx: Tx, shopId: string): Promise<ProgramRow | undefined> {
  const { rows } = await tx.execute<ProgramRow>(sql`
    SELECT enabled, referrer_credit::text, friend_credit::text, credit_days,
           minimum_order::text, updated_at
      FROM messaging.referral_programs WHERE shop_id = ${shopId}`);
  return rows[0];
}

/** The shop's referral programme while it is on, in the caller's transaction; null while off. */
export async function referralProgramIn(
  tx: Tx,
  shopId: string,
): Promise<ReferralProgramRecord | null> {
  const row = await programRowIn(tx, shopId);
  return row?.enabled ? recordOf(row) : null;
}

/** A new code: eight of {@link CODE_ALPHABET}. */
function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Customer `customerId`'s referral code, in the caller's transaction: made the first time it is
 * asked for, another tried where one was taken. Null where the shop has no such customer.
 */
export async function referralCodeIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await tx.execute<{ code: string }>(sql`
      WITH made AS (
        INSERT INTO messaging.referral_codes (shop_id, customer_id, code)
        SELECT ${shopId}, c.id, ${newCode()} FROM customers.customers c
         WHERE c.shop_id = ${shopId} AND c.id = ${customerId}
        ON CONFLICT DO NOTHING
        RETURNING code
      )
      SELECT code FROM made
      UNION ALL
      SELECT code FROM messaging.referral_codes
       WHERE shop_id = ${shopId} AND customer_id = ${customerId}`);
    if (rows[0]) return rows[0].code;
    const { rows: customers } = await tx.execute(sql`
      SELECT 1 FROM customers.customers WHERE shop_id = ${shopId} AND id = ${customerId}`);
    if (customers.length === 0) return null;
    // Another customer's code: try another.
  }
  throw new Error('No referral code could be made');
}

/** The customer whose code `code` is, in the caller's transaction; null for none. */
export async function referrerOfIn(tx: Tx, shopId: string, code: string): Promise<string | null> {
  const { rows } = await tx.execute<{ customer_id: string }>(sql`
    SELECT customer_id FROM messaging.referral_codes
     WHERE shop_id = ${shopId} AND code = ${code.toUpperCase()}`);
  return rows[0]?.customer_id ?? null;
}

/** Whether order `orderId`'s referral was dealt with, either way. */
export async function referralRecordedIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM messaging.referrals WHERE shop_id = ${shopId} AND order_id = ${orderId}`);
  return rows.length > 0;
}

/** How many referrals customer `referrerId` was rewarded for in the 30 days before `at`. */
export async function referralsRewardedIn(
  tx: Tx,
  shopId: string,
  referrerId: string,
  at: Date,
): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messaging.referrals
     WHERE shop_id = ${shopId} AND referrer_id = ${referrerId} AND outcome = 'rewarded'
       AND created_at > ${new Date(at.getTime() - 30 * 86_400_000).toISOString()}`);
  return rows[0]!.count;
}

/** Keeps what became of order `referral.orderId`'s referral, once. */
export async function recordReferralIn(
  tx: Tx,
  shopId: string,
  referral: Omit<ReferralRecord, 'createdAt'>,
  at: Date,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    INSERT INTO messaging.referrals
           (shop_id, order_id, referrer_id, friend_id, outcome, reason, referrer_credit,
            friend_credit, created_at)
    VALUES (${shopId}, ${referral.orderId}, ${referral.referrerId}, ${referral.friendId},
            ${referral.outcome}, ${referral.reason}, ${referral.referrerCredit},
            ${referral.friendCredit}, ${at.toISOString()})
    ON CONFLICT DO NOTHING
    RETURNING 1`);
  return rows.length > 0;
}

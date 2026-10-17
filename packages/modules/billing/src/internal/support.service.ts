import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { parsePkMobile } from '@hatti/pk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PLANS, type PlanCode } from './plans.js';

// Hatti's support for shops (BIL-05, ADR-508): where a shop reaches Hatti's people, as its plan
// allows, from the docs/product/03 pricing: Free has the help centre and requests answered in two
// days; Starter WhatsApp, in a day; Growth priority WhatsApp; Pro priority WhatsApp and a call.
// A request from the admin is kept either way, answered by Hatti's people from their own tool in
// order of priority and then of age, its answer shown in the admin.

/** How a shop reaches Hatti's people. */
export type SupportChannel = 'help_centre' | 'whatsapp' | 'priority_whatsapp' | 'priority_call';

export interface SupportTier {
  channel: SupportChannel;
  /** 1 is answered first. */
  priority: 1 | 2 | 3;
  /** How soon a request is answered, in working hours. */
  answerWithinHours: number;
}

export const SUPPORT_TIERS: Readonly<Record<PlanCode, SupportTier>> = {
  free: { channel: 'help_centre', priority: 3, answerWithinHours: 48 },
  starter: { channel: 'whatsapp', priority: 2, answerWithinHours: 24 },
  growth: { channel: 'priority_whatsapp', priority: 1, answerWithinHours: 8 },
  pro: { channel: 'priority_call', priority: 1, answerWithinHours: 4 },
};

export const SUPPORT_TOPICS = [
  'orders',
  'payments',
  'couriers',
  'store',
  'billing',
  'account',
  'other',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export const SUPPORT_LIMITS = {
  message: { min: 10, max: 2000 },
  answer: 4000,
  /** Requests a shop may have open at once. */
  open: 5,
  /** Requests the admin lists. */
  listed: 20,
} as const;

/** Hatti's own support lines, from the host's configuration; null where none is set. */
export interface SupportContact {
  /** Hatti's support WhatsApp number, E.164: "+923001234567". */
  whatsapp: string | null;
  /** Hatti's support phone line, as dialled: "+924235761999". */
  phone: string | null;
  email: string | null;
  /** When Hatti's people answer, in English and Urdu: "Monday to Saturday, 10am to 7pm". */
  hours: { en: string; ur: string } | null;
}

export const SUPPORT_CONTACT = Symbol('SUPPORT_CONTACT');

/** Where the shop reaches Hatti's people, as its plan allows. */
export interface SupportRecord {
  plan: PlanCode;
  tier: SupportTier;
  /** Hatti's WhatsApp, for plans that have it. */
  whatsapp: string | null;
  /** Hatti's phone line, for the plan with calls. */
  phone: string | null;
  email: string | null;
  hours: { en: string; ur: string } | null;
}

export type SupportStatus = 'open' | 'answered' | 'closed';

export interface SupportRequestRecord {
  id: string;
  topic: SupportTopic;
  message: string;
  language: 'en' | 'ur';
  callBack: string | null;
  priority: number;
  status: SupportStatus;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
  createdAt: Date;
}

/** A request waiting for Hatti's people, with its shop. */
export interface OpenSupportRequest extends SupportRequestRecord {
  shopId: string;
  shopName: string;
  plan: PlanCode;
}

type SupportRow = {
  id: string;
  topic: SupportTopic;
  message: string;
  language: 'en' | 'ur';
  call_back: string | null;
  priority: number;
  status: SupportStatus;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | Date | null;
  created_at: string | Date;
};

const COLUMNS = sql.raw(
  'id, topic, message, language, call_back, priority, status, answer, answered_by, ' +
    'answered_at, created_at',
);

function toRecord(row: SupportRow): SupportRequestRecord {
  return {
    id: row.id,
    topic: row.topic,
    message: row.message,
    language: row.language,
    callBack: row.call_back,
    priority: Number(row.priority),
    status: row.status,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at === null ? null : toDate(row.answered_at),
    createdAt: toDate(row.created_at),
  };
}

/** The shop's plan now: Free where it pays for none. */
async function planIn(tx: Tx, shopId: string): Promise<PlanCode> {
  const { rows } = await tx.execute<{ plan: PlanCode }>(sql`
    SELECT plan FROM billing.subscriptions WHERE shop_id = ${shopId}`);
  const plan = rows[0]?.plan;
  return plan && plan in PLANS ? plan : 'free';
}

@Injectable()
export class SupportService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(SUPPORT_CONTACT) private readonly contact: SupportContact | null = null,
  ) {}

  /** Where the shop reaches Hatti's people, as its plan allows. */
  async support(tenant: TenantContext): Promise<SupportRecord> {
    const plan = await this.db.tenant(tenant.shopId, (tx) => planIn(tx, tenant.shopId));
    const tier = SUPPORT_TIERS[plan];
    const contact = this.contact;
    return {
      plan,
      tier,
      whatsapp: tier.channel === 'help_centre' ? null : (contact?.whatsapp ?? null),
      phone: tier.channel === 'priority_call' ? (contact?.phone ?? null) : null,
      email: contact?.email ?? null,
      hours: contact?.hours ?? null,
    };
  }

  /** The shop's latest requests, the newest first. */
  async requests(tenant: TenantContext): Promise<SupportRequestRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<SupportRow>(sql`
        SELECT ${COLUMNS} FROM billing.support_requests
         WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${SUPPORT_LIMITS.listed}`);
      return rows.map(toRecord);
    });
  }

  /**
   * Asks Hatti's people for help, as the signed-in member of staff: what it is about, in their
   * words and language, and a mobile to call back at if they want a call. Answered as the shop's
   * plan now allows; at most five open at once.
   */
  async request(
    tenant: TenantContext,
    input: { topic: string; message: string; language: 'en' | 'ur'; callBack?: string | null },
  ): Promise<MutationResult<SupportRequestRecord>> {
    if (tenant.actor.kind !== 'staff') {
      return failOne(['input'], 'INVALID', 'Support requests come from staff, not from apps');
    }
    if (!(SUPPORT_TOPICS as readonly string[]).includes(input.topic)) {
      return failOne(['input', 'topic'], 'INVALID', `must be one of ${SUPPORT_TOPICS.join(', ')}`);
    }
    const message = input.message.trim();
    if (message.length < SUPPORT_LIMITS.message.min) {
      return failOne(['input', 'message'], 'INVALID', 'Say a little more of what you need');
    }
    if (message.length > SUPPORT_LIMITS.message.max) {
      return failOne(
        ['input', 'message'],
        'TOO_LONG',
        `must be at most ${SUPPORT_LIMITS.message.max} characters`,
      );
    }
    let callBack: string | null = null;
    if (input.callBack?.trim()) {
      const mobile = parsePkMobile(input.callBack);
      if (!mobile) {
        return failOne(['input', 'callBack'], 'INVALID', 'must be a Pakistani mobile number');
      }
      callBack = mobile.e164;
    }
    const userId = tenant.actor.userId;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: open } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM billing.support_requests
         WHERE shop_id = ${tenant.shopId} AND status = 'open'`);
      if (open[0]!.count >= SUPPORT_LIMITS.open) {
        return failOne<SupportRequestRecord>(
          ['base'],
          'TOO_MANY',
          `The shop has ${SUPPORT_LIMITS.open} requests waiting: Hatti answers those first`,
        );
      }
      const plan = await planIn(tx, tenant.shopId);
      const { rows } = await tx.execute<SupportRow>(sql`
        INSERT INTO billing.support_requests
               (shop_id, topic, message, language, call_back, plan, priority, opened_by)
        VALUES (${tenant.shopId}, ${input.topic}, ${message}, ${input.language}, ${callBack},
                ${plan}, ${SUPPORT_TIERS[plan].priority}, ${userId})
        RETURNING ${COLUMNS}`);
      return { ok: true as const, value: toRecord(rows[0]!) };
    });
  }

  /** Closes one of the shop's requests: answered enough, or no longer needed. */
  async close(tenant: TenantContext, id: string): Promise<SupportRequestRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<SupportRow>(sql`
        UPDATE billing.support_requests SET status = 'closed', closed_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id} AND status <> 'closed'
        RETURNING ${COLUMNS}`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /**
   * The requests waiting for Hatti's people, across shops, the most urgent then the oldest first:
   * with the system role, for Hatti's own people alone, never through the Admin API.
   */
  async waiting(): Promise<OpenSupportRequest[]> {
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<
        SupportRow & { shop_id: string; shop_name: string; plan: PlanCode }
      >(sql`
        SELECT r.id, r.topic, r.message, r.language, r.call_back, r.priority, r.status, r.answer,
               r.answered_by, r.answered_at, r.created_at, r.shop_id, r.plan,
               s.name AS shop_name
          FROM billing.support_requests r
          JOIN control.shops s ON s.id = r.shop_id
         WHERE r.status = 'open'
         ORDER BY r.priority, r.created_at`);
      return rows.map((row) => ({
        ...toRecord(row),
        shopId: row.shop_id,
        shopName: row.shop_name,
        plan: row.plan,
      }));
    });
  }

  /**
   * Hatti's people's answer to a request, by `by`, in the language the shop asked in: shown in
   * the admin. A request answered before, or closed, keeps its answer.
   */
  async answer(id: string, text: string, by: string): Promise<MutationResult<OpenSupportRequest>> {
    const answer = text.trim();
    if (!answer) return failOne(['answer'], 'BLANK', 'Say what Hatti answers');
    if (answer.length > SUPPORT_LIMITS.answer) {
      return failOne(['answer'], 'TOO_LONG', `must be at most ${SUPPORT_LIMITS.answer} characters`);
    }
    const who = by.trim();
    if (!who) return failOne(['by'], 'BLANK', 'Say who answers');
    const found = (await this.waiting()).find((each) => each.id === id);
    if (!found) return failOne(['id'], 'NOT_FOUND', 'No such request waits for an answer');
    const answered = await this.db.tenant(found.shopId, async (tx) => {
      const { rows } = await tx.execute<SupportRow>(sql`
        UPDATE billing.support_requests
           SET status = 'answered', answer = ${answer}, answered_by = ${who.slice(0, 80)},
               answered_at = now()
         WHERE shop_id = ${found.shopId} AND id = ${id} AND status = 'open'
        RETURNING ${COLUMNS}`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
    if (!answered) return failOne(['id'], 'NOT_FOUND', 'No such request waits for an answer');
    return { ok: true, value: { ...found, ...answered } };
  }
}

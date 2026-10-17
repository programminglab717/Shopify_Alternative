import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { staffOfPhone } from '@hatti/identity/public';
import {
  CONVERSATION_WINDOW_MS,
  type InboundMessage,
  type StatusUpdate,
  type SupportInbox,
} from '@hatti/messaging/public';
import { parsePkMobile } from '@hatti/pk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PLAN_CODES, PLANS, type PlanCode } from './plans.js';
import {
  SUPPORT_WHATSAPP_SENDER,
  inUrduScript,
  type SupportWhatsAppSender,
} from './support-whatsapp.js';

// Hatti's support for shops (BIL-05, ADR-508): where a shop reaches Hatti's people, as its plan
// allows, from the docs/product/03 pricing: Free has the help centre and requests answered in two
// days; Starter WhatsApp, in a day; Growth priority WhatsApp; Pro priority WhatsApp and a call.
// A request from the admin is kept either way, answered by Hatti's people from their own tool in
// order of priority and then of age, its answer shown in the admin. What staff write to Hatti's
// support WhatsApp number is kept as a request of their shop too (ADR-560): what they write while
// one of theirs is open is added to it, and the answer goes back to them on WhatsApp as well,
// within the day WhatsApp allows.

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
  /** A request's latest messages on WhatsApp the admin shows (ADR-560). */
  messages: 50,
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

/** Where a request was asked: in the admin, or on Hatti's support WhatsApp number (ADR-560). */
export type SupportRequestChannel = 'admin' | 'whatsapp';

export interface SupportRequestRecord {
  id: string;
  channel: SupportRequestChannel;
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
  /** When its plan says it is answered by (ADR-525). */
  dueAt: Date;
  /**
   * What they last wrote about it on WhatsApp, as "[image]" for what held no words, and when;
   * null for a request no one wrote about there (ADR-560).
   */
  lastInbound: { text: string; at: Date } | null;
}

/**
 * How an answer went on WhatsApp (ADR-560): sent, with WhatsApp's ID; not sent, as more than a
 * day passed since they last wrote, or as no support number is set up; failed, with why; none
 * for a request no one wrote about there.
 */
export type SupportWhatsAppOutcome =
  | { kind: 'sent'; id: string }
  | { kind: 'window_closed' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; error: string }
  | { kind: 'none' };

/** A request answered, and how the answer went on WhatsApp. */
export interface AnsweredSupportRequest extends OpenSupportRequest {
  whatsapp: SupportWhatsAppOutcome;
}

export type SupportMessageDirection = 'inbound' | 'outbound';
export type SupportMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** A message about a request on WhatsApp: what staff wrote, or Hatti's answer (ADR-560). */
export interface SupportMessageRecord {
  id: string;
  requestId: string;
  direction: SupportMessageDirection;
  body: string | null;
  /** What else it held, as WhatsApp names it: "image"; null for words alone. */
  mediaKind: string | null;
  at: Date;
  /** How an answer went, as WhatsApp says; null for what staff wrote. */
  status: SupportMessageStatus | null;
  /** Why WhatsApp did not take or deliver an answer. */
  error: string | null;
}

/** What WhatsApp's statuses may move an answer on from: never back, and failed only undelivered. */
const STATUS_FROM: Record<StatusUpdate['status'], readonly SupportMessageStatus[]> = {
  sent: [],
  delivered: ['sent'],
  read: ['sent', 'delivered'],
  failed: ['sent'],
};

/** A request's words for a message that held none: "[image]". */
function placeholderOf(mediaKind: string): string {
  return `[${mediaKind}]`;
}

/**
 * When a request asked at `createdAt` on `plan` is due an answer (ADR-525): its plan's hours
 * after, counted on the clock.
 */
export function supportDueAt(plan: PlanCode, createdAt: Date): Date {
  return new Date(createdAt.getTime() + SUPPORT_TIERS[plan].answerWithinHours * 3_600_000);
}

type OpenRow = SupportRow & {
  shop_id: string;
  shop_name: string;
  plan: PlanCode;
  inbound_body: string | null;
  inbound_media_kind: string | null;
  inbound_at: string | Date | null;
};

function toOpen(row: OpenRow): OpenSupportRequest {
  const record = toRecord(row);
  const inboundAt = toDateOrNull(row.inbound_at);
  const text =
    row.inbound_body ?? (row.inbound_media_kind && placeholderOf(row.inbound_media_kind));
  return {
    ...record,
    shopId: row.shop_id,
    shopName: row.shop_name,
    plan: row.plan,
    dueAt: supportDueAt(row.plan, record.createdAt),
    lastInbound: inboundAt && text ? { text, at: inboundAt } : null,
  };
}

/** A waiting request's shop and plan, and what was last written about it on WhatsApp. */
const OPEN_COLUMNS = sql.raw(
  'r.id, r.channel, r.topic, r.message, r.language, r.call_back, r.priority, r.status, ' +
    'r.answer, r.answered_by, r.answered_at, r.created_at, r.shop_id, r.plan, ' +
    's.name AS shop_name, i.body AS inbound_body, i.media_kind AS inbound_media_kind, ' +
    'i.at AS inbound_at',
);
const LAST_INBOUND = sql.raw(`
  LEFT JOIN LATERAL (
    SELECT m.body, m.media_kind, m.at FROM billing.support_request_messages m
     WHERE m.shop_id = r.shop_id AND m.request_id = r.id AND m.direction = 'inbound'
     ORDER BY m.at DESC, m.id DESC LIMIT 1) i ON true`);

type SupportRow = {
  id: string;
  channel: SupportRequestChannel;
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
  'id, channel, topic, message, language, call_back, priority, status, answer, answered_by, ' +
    'answered_at, created_at',
);

function toRecord(row: SupportRow): SupportRequestRecord {
  return {
    id: row.id,
    channel: row.channel,
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

type MessageRow = {
  id: string;
  request_id: string;
  direction: SupportMessageDirection;
  body: string | null;
  media_kind: string | null;
  at: string | Date;
  status: SupportMessageStatus | null;
  error: string | null;
};

function toMessage(row: MessageRow): SupportMessageRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    direction: row.direction,
    body: row.body,
    mediaKind: row.media_kind,
    at: toDate(row.at),
    status: row.status,
    error: row.error,
  };
}

/**
 * Hatti's support for shops. It keeps what staff write to Hatti's support WhatsApp number too,
 * as the messaging module's {@link SupportInbox} (ADR-560); its answers go out there through the
 * sender the host gives, without which they are kept and shown in the admin alone.
 */
@Injectable()
export class SupportService implements SupportInbox {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(SUPPORT_CONTACT) private readonly contact: SupportContact | null = null,
    @Optional()
    @Inject(SUPPORT_WHATSAPP_SENDER)
    private readonly whatsapp: SupportWhatsAppSender | null = null,
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
   * The latest messages on WhatsApp of each of the shop's requests `requestIds` (ADR-560), at
   * most {@link SUPPORT_LIMITS.messages} each, the oldest first; none for a request no one wrote
   * about there.
   */
  async messagesOf(
    shopId: string,
    requestIds: readonly string[],
  ): Promise<Map<string, SupportMessageRecord[]>> {
    const byRequest = new Map<string, SupportMessageRecord[]>(requestIds.map((id) => [id, []]));
    if (requestIds.length === 0) return byRequest;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<MessageRow>(sql`
        SELECT id, request_id, direction, body, media_kind, at, status, error
          FROM (SELECT m.*, row_number() OVER (PARTITION BY m.request_id
                                               ORDER BY m.at DESC, m.id DESC) AS n
                  FROM billing.support_request_messages m
                 WHERE m.shop_id = ${shopId}
                   AND m.request_id = ANY(${sql.param([...requestIds])}::uuid[])) latest
         WHERE n <= ${SUPPORT_LIMITS.messages}
         ORDER BY at, id`),
    );
    for (const row of rows) byRequest.get(row.request_id)?.push(toMessage(row));
    return byRequest;
  }

  /**
   * Keeps `message`, which a member of staff wrote to Hatti's support WhatsApp number (ADR-560),
   * as a request of their shop: once, however often WhatsApp's webhook names it. Found by the
   * number their account proved, through identity's facade, in the shops they are staff of: added
   * to their open request last written about, in any of them; else a new request, in the shop they
   * last asked in, or else the one they joined first, as the shop's plan answers it. Where the shop
   * has as many open as it may, it is added to the newest. Whether it was kept: not for a number
   * no account of staff proved, nor for a message with nothing in it.
   */
  async recordWhatsApp(message: InboundMessage): Promise<boolean> {
    const text = message.text?.trim() || null;
    if (!text && !message.mediaKind) return false;
    const memberships = await staffOfPhone(this.db.app, message.from);
    const [first] = memberships;
    if (!first) return false;
    // A number proved is one account's alone.
    const userId = first.userId;
    const { rows: found } = await this.db.app.execute<{
      shop_id: string;
      request_id: string | null;
    }>(sql`
      SELECT shop_id, request_id FROM billing.resolve_support_sender(
               ${userId}, ${sql.param(memberships.map((each) => each.shopId))}::uuid[])`);
    const shopId = found[0]?.shop_id ?? first.shopId;
    const at = message.at.toISOString();
    return this.db.tenant(shopId, async (tx) => {
      let requestId = found[0]?.request_id ?? null;
      if (!requestId) {
        const { rows: open } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM billing.support_requests
           WHERE shop_id = ${shopId} AND status = 'open'
           ORDER BY created_at DESC, id DESC`);
        if (open.length >= SUPPORT_LIMITS.open) requestId = open[0]!.id;
      }
      let opened = false;
      if (!requestId) {
        const plan = await planIn(tx, shopId);
        const words = (text ?? placeholderOf(message.mediaKind!)).slice(
          0,
          SUPPORT_LIMITS.message.max,
        );
        const language = text && inUrduScript(text) ? 'ur' : first.language;
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO billing.support_requests
                 (shop_id, channel, topic, message, language, plan, priority, opened_by,
                  whatsapp_from, last_inbound_at)
          VALUES (${shopId}, 'whatsapp', 'other', ${words}, ${language}, ${plan},
                  ${SUPPORT_TIERS[plan].priority}, ${userId}, ${message.from}, ${at})
          RETURNING id`);
        requestId = rows[0]!.id;
        opened = true;
      }
      const { rows: kept } = await tx.execute<{ id: string }>(sql`
        INSERT INTO billing.support_request_messages
               (shop_id, request_id, direction, body, media_kind, whatsapp_id, at)
        VALUES (${shopId}, ${requestId}, 'inbound', ${text}, ${message.mediaKind}, ${message.id},
                ${at})
            ON CONFLICT (whatsapp_id) WHERE whatsapp_id IS NOT NULL DO NOTHING
        RETURNING id`);
      if (kept.length === 0) {
        // Kept before: the request opened for it again is not wanted.
        if (opened) {
          await tx.execute(sql`
            DELETE FROM billing.support_requests WHERE shop_id = ${shopId} AND id = ${requestId}`);
        }
        return true;
      }
      if (!opened) {
        await tx.execute(sql`
          UPDATE billing.support_requests
             SET whatsapp_from = ${message.from},
                 last_inbound_at = greatest(last_inbound_at, ${at}::timestamptz)
           WHERE shop_id = ${shopId} AND id = ${requestId}`);
      }
      return true;
    });
  }

  /**
   * How Hatti's answers from its support number went, as WhatsApp's webhook says (ADR-560):
   * delivered, then read; failed only before delivery. Each found by its ID across shops, then
   * changed as its shop. Those not found are given back.
   */
  async recordStatuses(updates: readonly StatusUpdate[]): Promise<StatusUpdate[]> {
    if (updates.length === 0) return [];
    const { rows } = await this.db.app.execute<{
      shop_id: string;
      message_id: string;
      whatsapp_id: string;
    }>(sql`
      SELECT shop_id, message_id, whatsapp_id
        FROM billing.resolve_support_messages(
               ${sql.param(updates.map((update) => update.providerMessageId))}::text[])`);
    const found = new Map(rows.map((row) => [row.whatsapp_id, row]));
    for (const update of updates) {
      const answer = found.get(update.providerMessageId);
      if (!answer) continue;
      const from = STATUS_FROM[update.status];
      if (from.length === 0) continue;
      await this.db.tenant(answer.shop_id, (tx) =>
        tx.execute(sql`
          UPDATE billing.support_request_messages
             SET status = ${update.status},
                 error = CASE WHEN ${update.status} = 'failed'
                              THEN ${(update.error ?? 'WhatsApp could not deliver it').slice(0, 1_000)}
                              ELSE error END
           WHERE shop_id = ${answer.shop_id} AND id = ${answer.message_id}
             AND status = ANY(${sql.param(from)}::text[])`),
      );
    }
    return updates.filter((update) => !found.has(update.providerMessageId));
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
      const { rows } = await tx.execute<OpenRow>(sql`
        SELECT ${OPEN_COLUMNS}
          FROM billing.support_requests r
          JOIN control.shops s ON s.id = r.shop_id
          ${LAST_INBOUND}
         WHERE r.status = 'open'
         ORDER BY r.priority, r.created_at`);
      return rows.map(toOpen);
    });
  }

  /**
   * The requests still open at `now` past the time their plan answers in (ADR-525), each once:
   * marked as flagged as they are found, so the next sweep finds only those late since. The most
   * urgent then the oldest first, with the system role, for Hatti's own people alone.
   */
  async overdue(now: Date = new Date()): Promise<OpenSupportRequest[]> {
    const hours = sql.join(
      PLAN_CODES.map((code) => sql`(${code}::text, ${SUPPORT_TIERS[code].answerWithinHours}::int)`),
      sql`, `,
    );
    const { rows } = await this.db.system((tx) =>
      tx.execute<OpenRow>(sql`
        WITH flagged AS (
          UPDATE billing.support_requests f
             SET overdue_at = ${now}
            FROM (VALUES ${hours}) AS t (plan, hours)
           WHERE t.plan = f.plan
             AND f.status = 'open' AND f.overdue_at IS NULL
             AND f.created_at + make_interval(hours => t.hours) <= ${now}
          RETURNING f.*)
        SELECT ${OPEN_COLUMNS}
          FROM flagged r
          JOIN control.shops s ON s.id = r.shop_id
          ${LAST_INBOUND}`),
    );
    return rows
      .map(toOpen)
      .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Hatti's people's answer to a request, by `by`, in the language the shop asked in: shown in
   * the admin. A request answered before, or closed, keeps its answer. For one they wrote about on
   * WhatsApp, it goes back to them there too, from Hatti's support number, while WhatsApp lets it:
   * within a day of their last message at `now` (ADR-560); kept with how it went.
   */
  async answer(
    id: string,
    text: string,
    by: string,
    now: Date = new Date(),
  ): Promise<MutationResult<AnsweredSupportRequest>> {
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
      const { rows } = await tx.execute<
        SupportRow & { whatsapp_from: string | null; last_inbound_at: string | Date | null }
      >(sql`
        UPDATE billing.support_requests
           SET status = 'answered', answer = ${answer}, answered_by = ${who.slice(0, 80)},
               answered_at = now()
         WHERE shop_id = ${found.shopId} AND id = ${id} AND status = 'open'
        RETURNING ${COLUMNS}, whatsapp_from, last_inbound_at`);
      return rows[0] ?? null;
    });
    if (!answered) return failOne(['id'], 'NOT_FOUND', 'No such request waits for an answer');
    const whatsapp = await this.#sendAnswer(
      found.shopId,
      id,
      answer,
      answered.whatsapp_from,
      toDateOrNull(answered.last_inbound_at),
      now,
    );
    return { ok: true, value: { ...found, ...toRecord(answered), whatsapp } };
  }

  /**
   * Sends Hatti's answer to request `id` back to `to` on WhatsApp, where they wrote about it and
   * last did so within the day WhatsApp lets a business write freely: kept as the request's
   * message with how it went, sent with WhatsApp's ID, or failed with why.
   */
  async #sendAnswer(
    shopId: string,
    id: string,
    answer: string,
    to: string | null,
    lastInboundAt: Date | null,
    now: Date,
  ): Promise<SupportWhatsAppOutcome> {
    if (!to || !lastInboundAt) return { kind: 'none' };
    if (now.getTime() - lastInboundAt.getTime() >= CONVERSATION_WINDOW_MS) {
      return { kind: 'window_closed' };
    }
    if (!this.whatsapp) return { kind: 'unavailable' };
    const sent = await this.whatsapp.send(to, answer);
    const error = sent.ok ? null : sent.error.slice(0, 1_000);
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO billing.support_request_messages
               (shop_id, request_id, direction, body, whatsapp_id, status, error, at)
        VALUES (${shopId}, ${id}, 'outbound', ${answer}, ${sent.ok ? sent.id : null},
                ${sent.ok ? 'sent' : 'failed'}, ${error}, ${now.toISOString()})`),
    );
    return sent.ok ? { kind: 'sent', id: sent.id } : { kind: 'failed', error: error! };
  }
}

import { PlanAllowance, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { voiceOrdersOnIn } from './voice-orders.service.js';

// The shop's AI support agent (MSG-07, ADR-849): once the shop turns it on, the AI answers its
// customers' messages, on WhatsApp and in its web chat, from what the worker gives it of the
// shop and the customer's own orders, and hands the conversation to staff when it should. Here:
// the setting, whether a message is the AI's to answer, the conversation as the AI reads it, and
// what came of each answer, for the day's limit. It never answers a conversation given to a
// member of staff, one staff answered in the last day, or one it handed over in the last day.

/** The most the AI answers a shop's customers a day. */
export const SUPPORT_AGENT_DAILY = 200;

/** The shop's answers to its customers' common questions, and how long each may be (ADR-911). */
export const SUPPORT_FAQ_LIMITS = { faqs: 30, question: 200, answer: 1_000 } as const;

/** How the AI writes to the shop's customers (ADR-923): as a shopkeeper would, or formally. */
export const SUPPORT_TONES = ['warm', 'formal'] as const;
export type SupportTone = (typeof SUPPORT_TONES)[number];

/** The name the shop gives its assistant, and how long it may be (ADR-923). */
export const SUPPORT_AGENT_NAME_MAX = 40;

/** Who the AI is to the shop's customers (ADR-923): its name, if the shop gave one, and tone. */
export interface SupportVoice {
  name: string | null;
  tone: SupportTone;
}

/** A question the shop's customers ask, and the shop's answer, for the AI to answer from. */
export interface SupportFaq {
  question: string;
  answer: string;
}

/** How long the AI leaves a conversation once staff answer it, or it hands it to them. */
export const SUPPORT_AGENT_QUIET_MS = 24 * 60 * 60 * 1000;

export type SupportAgentOutcome =
  'replied' | 'handed_off' | 'refused' | 'failed' | 'invalid' | 'unsent';

export interface SupportAgentSettingsRecord {
  enabled: boolean;
  faqs: SupportFaq[];
  voice: SupportVoice;
  /** How many messages it answered in the last day, and the most it answers. */
  answeredToday: number;
  limitPerDay: number;
}

/** A message the AI is to answer: its conversation, as the AI reads it. */
export interface SupportAgentTask {
  conversationId: string;
  messageId: string;
  channel: 'whatsapp' | 'web';
  /** E.164: the customer's number, verified by WhatsApp; typed by the shopper in a web chat. */
  customerPhone: string;
  /**
   * The conversation's latest messages with words, oldest first: a voice note as it was heard,
   * where it was (ADR-940).
   */
  history: { from: 'customer' | 'shop'; text: string }[];
  /**
   * The message to answer is a voice note without words (ADR-940): where WhatsApp keeps it, to
   * be heard before it is answered.
   */
  listen?: { mediaId: string; viaPhoneNumberId: string | null };
  /** The message to answer is a picture, a video or a file without words: staff's to see. */
  unreadable?: string;
  /** The shop's answers to common questions (ADR-911). */
  faqs: SupportFaq[];
  /** Its assistant's name and tone (ADR-923). */
  voice: SupportVoice;
}

type ConversationRow = {
  channel: 'whatsapp' | 'web';
  customer_phone: string;
  assignee_id: string | null;
  via_phone_number_id: string | null;
};

type HistoryRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  actor_kind: string | null;
  at: Date | string;
  cart: boolean;
  media_kind: string | null;
  media_id: string | null;
  transcript: string | null;
};

async function answeredSince(tx: Tx, shopId: string, since: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messaging.support_agent_replies
     WHERE shop_id = ${shopId} AND outcome IN ('replied', 'handed_off')
       AND created_at > ${since.toISOString()}`);
  return rows[0]!.count;
}

@Injectable()
export class SupportAgentService {
  constructor(
    private readonly db: Database,
    /** What the shop's plan includes (ADR-154): the AI answers on Growth and above. */
    @Optional() @Inject(PlanAllowance) private readonly allowance?: PlanAllowance | null,
  ) {}

  async settings(
    tenant: TenantContext,
    now: Date = new Date(),
  ): Promise<SupportAgentSettingsRecord> {
    return this.db.tenant(tenant.shopId, async (tx) => ({
      enabled: await enabledIn(tx, tenant.shopId),
      faqs: await faqsIn(tx, tenant.shopId),
      voice: await voiceIn(tx, tenant.shopId),
      answeredToday: await answeredSince(
        tx,
        tenant.shopId,
        new Date(now.getTime() - SUPPORT_AGENT_QUIET_MS),
      ),
      limitPerDay: SUPPORT_AGENT_DAILY,
    }));
  }

  /** Turns the AI's answers on or off. */
  async update(
    tenant: TenantContext,
    input: { enabled: boolean },
  ): Promise<MutationResult<SupportAgentSettingsRecord>> {
    const plan = input.enabled && (await this.allowance?.excludes(tenant.shopId, 'aiSupportAgent'));
    if (plan) {
      return failOne(
        ['enabled'],
        'PROHIBITED',
        `The ${plan} plan doesn't include AI answers: choose the Growth plan for them`,
      );
    }
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.support_agent_settings (shop_id, enabled)
        VALUES (${tenant.shopId}, ${input.enabled})
        ON CONFLICT (shop_id) DO UPDATE SET enabled = excluded.enabled, updated_at = now()`),
    );
    return { ok: true, value: await this.settings(tenant) };
  }

  /**
   * Sets the shop's answers to its customers' common questions, in the order given, for the AI to
   * answer from (ADR-911): each question and answer trimmed, neither empty, none asked twice.
   */
  async setFaqs(
    tenant: TenantContext,
    given: readonly SupportFaq[],
  ): Promise<MutationResult<SupportAgentSettingsRecord>> {
    if (given.length > SUPPORT_FAQ_LIMITS.faqs) {
      return failOne(['faqs'], 'TOO_LONG', `Keep ${SUPPORT_FAQ_LIMITS.faqs} questions at most`);
    }
    const faqs: SupportFaq[] = [];
    const asked = new Set<string>();
    for (const [at, faq] of given.entries()) {
      const question = faq.question.trim().replace(/\s+/g, ' ');
      const answer = faq.answer.trim();
      if (!question || question.length > SUPPORT_FAQ_LIMITS.question) {
        return failOne(
          ['faqs', String(at), 'question'],
          'INVALID',
          `Write the question, in ${SUPPORT_FAQ_LIMITS.question} characters at most`,
        );
      }
      if (!answer || answer.length > SUPPORT_FAQ_LIMITS.answer) {
        return failOne(
          ['faqs', String(at), 'answer'],
          'INVALID',
          `Write the answer, in ${SUPPORT_FAQ_LIMITS.answer} characters at most`,
        );
      }
      if (asked.has(question.toLowerCase())) {
        return failOne(['faqs', String(at), 'question'], 'TAKEN', 'That question is asked already');
      }
      asked.add(question.toLowerCase());
      faqs.push({ question, answer });
    }
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.support_agent_settings (shop_id, faqs)
        VALUES (${tenant.shopId}, ${JSON.stringify(faqs)}::jsonb)
        ON CONFLICT (shop_id) DO UPDATE SET faqs = excluded.faqs, updated_at = now()`),
    );
    return { ok: true, value: await this.settings(tenant) };
  }

  /**
   * Names the shop's assistant, or leaves it unnamed with a blank `name`, and sets its tone
   * (ADR-923): the name trimmed, 40 characters at most, and none of `<` or `>`, as it is given
   * the model between tags.
   */
  async setVoice(
    tenant: TenantContext,
    input: { name?: string | null; tone: string },
  ): Promise<MutationResult<SupportAgentSettingsRecord>> {
    const name = (input.name ?? '').trim().replace(/\s+/g, ' ') || null;
    if (name && (name.length > SUPPORT_AGENT_NAME_MAX || /[<>]/.test(name))) {
      return failOne(
        ['name'],
        'INVALID',
        `Give it a name of ${SUPPORT_AGENT_NAME_MAX} characters at most, without < or >`,
      );
    }
    if (!(SUPPORT_TONES as readonly string[]).includes(input.tone)) {
      return failOne(['tone'], 'INVALID', `Its tone is ${SUPPORT_TONES.join(' or ')}`);
    }
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.support_agent_settings (shop_id, agent_name, tone)
        VALUES (${tenant.shopId}, ${name}, ${input.tone})
        ON CONFLICT (shop_id) DO UPDATE
           SET agent_name = excluded.agent_name, tone = excluded.tone, updated_at = now()`),
    );
    return { ok: true, value: await this.settings(tenant) };
  }

  /**
   * The message `messageId` of the conversation `conversationId`, as the AI is to answer it as
   * of `now`; null where it is not the AI's: the agent off, the day's answers given, the message
   * not the conversation's latest or not the customer's, already answered, or the conversation
   * given to a member of staff, answered by one, or handed to them, in the last day.
   */
  async taskOf(
    shopId: string,
    conversationId: string,
    messageId: string,
    now: Date = new Date(),
  ): Promise<SupportAgentTask | null> {
    // A shop whose plan no longer includes them is answered by its staff alone.
    if (await this.allowance?.excludes(shopId, 'aiSupportAgent')) return null;
    return this.db.tenant(shopId, async (tx) => {
      if (!(await enabledIn(tx, shopId))) return null;
      const since = new Date(now.getTime() - SUPPORT_AGENT_QUIET_MS);
      if ((await answeredSince(tx, shopId, since)) >= SUPPORT_AGENT_DAILY) return null;
      const { rows: conversations } = await tx.execute<ConversationRow>(sql`
        SELECT channel, customer_phone, assignee_id, via_phone_number_id
          FROM messaging.conversations
         WHERE shop_id = ${shopId} AND id = ${conversationId}`);
      const conversation = conversations[0];
      if (!conversation || conversation.assignee_id !== null) return null;
      const { rows: asked } = await tx.execute<{ handed: boolean; answered: boolean }>(sql`
        SELECT bool_or(outcome = 'handed_off' AND created_at > ${since.toISOString()}) AS handed,
               bool_or(message_id = ${messageId}) AS answered
          FROM messaging.support_agent_replies
         WHERE shop_id = ${shopId} AND conversation_id = ${conversationId}`);
      if (asked[0]?.handed || asked[0]?.answered) return null;
      const { rows } = await tx.execute<HistoryRow>(sql`
        SELECT id, direction, body, actor_kind, at, cart IS NOT NULL AS cart, media_kind,
               media_id, transcript
          FROM messaging.conversation_messages
         WHERE shop_id = ${shopId} AND conversation_id = ${conversationId}
         ORDER BY at DESC, id DESC
         LIMIT 20`);
      const latest = rows[0];
      if (!latest || latest.id !== messageId || latest.direction !== 'inbound') return null;
      // A cart from the shop's WhatsApp catalogue is answered with its checkout (ADR-856).
      if (latest.cart) return null;
      // A voice note, where the shop takes orders by them, is heard and answered so (ADR-871).
      if (latest.media_kind === 'audio' && (await voiceOrdersOnIn(tx, shopId))) return null;
      // Staff answered in the last day: theirs to go on with.
      if (
        rows.some(
          (row) =>
            row.direction === 'outbound' && row.actor_kind !== 'ai' && toDate(row.at) > since,
        )
      ) {
        return null;
      }
      const history = rows
        .filter((row) => row.body ?? row.transcript)
        .reverse()
        .map((row) => ({
          from: row.direction === 'inbound' ? ('customer' as const) : ('shop' as const),
          text: (row.body ?? row.transcript)!,
        }));
      // Without words, a voice note is heard first, and anything else is staff's (ADR-940).
      const wordless = !latest.body && !latest.transcript && latest.media_kind;
      const listen =
        wordless && latest.media_kind === 'audio' && latest.media_id
          ? { mediaId: latest.media_id, viaPhoneNumberId: conversation.via_phone_number_id }
          : null;
      return {
        conversationId,
        messageId,
        channel: conversation.channel,
        customerPhone: conversation.customer_phone,
        history,
        ...(listen && { listen }),
        ...(wordless && !listen && { unreadable: latest.media_kind! }),
        faqs: await faqsIn(tx, shopId),
        voice: await voiceIn(tx, shopId),
      };
    });
  }

  /** Keeps what came of answering the message `messageId`, and what it cost. */
  async record(
    shopId: string,
    task: Pick<SupportAgentTask, 'conversationId' | 'messageId'>,
    outcome: SupportAgentOutcome,
    usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.support_agent_replies
               (shop_id, conversation_id, message_id, outcome, input_tokens, output_tokens,
                created_at)
        VALUES (${shopId}, ${task.conversationId}, ${task.messageId}, ${outcome},
                ${usage.inputTokens}, ${usage.outputTokens}, ${now.toISOString()})
        ON CONFLICT (shop_id, message_id) DO NOTHING`),
    );
  }

  /**
   * The conversation, handed to staff by the AI: waiting for them from `now`, as when the
   * customer last wrote, so the inbox shows it waiting.
   */
  async handOff(shopId: string, conversationId: string, now: Date = new Date()): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE messaging.conversations
           SET waiting_since = coalesce(waiting_since, ${now.toISOString()}::timestamptz),
               unread = greatest(unread, 1)
         WHERE shop_id = ${shopId} AND id = ${conversationId}`),
    );
  }
}

async function faqsIn(tx: Tx, shopId: string): Promise<SupportFaq[]> {
  const { rows } = await tx.execute<{ faqs: SupportFaq[] }>(sql`
    SELECT faqs FROM messaging.support_agent_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.faqs ?? [];
}

async function voiceIn(tx: Tx, shopId: string): Promise<SupportVoice> {
  const { rows } = await tx.execute<{ agent_name: string | null; tone: SupportTone }>(sql`
    SELECT agent_name, tone FROM messaging.support_agent_settings WHERE shop_id = ${shopId}`);
  return { name: rows[0]?.agent_name ?? null, tone: rows[0]?.tone ?? 'warm' };
}

async function enabledIn(tx: Tx, shopId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ enabled: boolean }>(sql`
    SELECT enabled FROM messaging.support_agent_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.enabled ?? false;
}

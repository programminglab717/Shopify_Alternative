import { PlanAllowance, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// The shop's AI support agent (MSG-07, ADR-849): once the shop turns it on, the AI answers its
// customers' messages, on WhatsApp and in its web chat, from what the worker gives it of the
// shop and the customer's own orders, and hands the conversation to staff when it should. Here:
// the setting, whether a message is the AI's to answer, the conversation as the AI reads it, and
// what came of each answer, for the day's limit. It never answers a conversation given to a
// member of staff, one staff answered in the last day, or one it handed over in the last day.

/** The most the AI answers a shop's customers a day. */
export const SUPPORT_AGENT_DAILY = 200;

/** How long the AI leaves a conversation once staff answer it, or it hands it to them. */
export const SUPPORT_AGENT_QUIET_MS = 24 * 60 * 60 * 1000;

export type SupportAgentOutcome =
  'replied' | 'handed_off' | 'refused' | 'failed' | 'invalid' | 'unsent';

export interface SupportAgentSettingsRecord {
  enabled: boolean;
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
  /** The conversation's latest messages with words, oldest first. */
  history: { from: 'customer' | 'shop'; text: string }[];
}

type ConversationRow = {
  channel: 'whatsapp' | 'web';
  customer_phone: string;
  assignee_id: string | null;
};

type HistoryRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  actor_kind: string | null;
  at: Date | string;
  cart: boolean;
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
        SELECT channel, customer_phone, assignee_id FROM messaging.conversations
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
        SELECT id, direction, body, actor_kind, at, cart IS NOT NULL AS cart
          FROM messaging.conversation_messages
         WHERE shop_id = ${shopId} AND conversation_id = ${conversationId}
         ORDER BY at DESC, id DESC
         LIMIT 20`);
      const latest = rows[0];
      if (!latest || latest.id !== messageId || latest.direction !== 'inbound') return null;
      // A cart from the shop's WhatsApp catalogue is answered with its checkout (ADR-856).
      if (latest.cart) return null;
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
        .filter((row) => row.body)
        .reverse()
        .map((row) => ({
          from: row.direction === 'inbound' ? ('customer' as const) : ('shop' as const),
          text: row.body!,
        }));
      return {
        conversationId,
        messageId,
        channel: conversation.channel,
        customerPhone: conversation.customer_phone,
        history,
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

async function enabledIn(tx: Tx, shopId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ enabled: boolean }>(sql`
    SELECT enabled FROM messaging.support_agent_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.enabled ?? false;
}

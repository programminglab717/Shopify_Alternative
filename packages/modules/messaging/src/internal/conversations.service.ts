import { actorColumnsOf, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MessagingEvents,
  type ConversationMessageReceivedPayload,
  type ConversationRepliedPayload,
} from './events.js';
import type { Page, StatusUpdate } from './messages.service.js';
import { WHATSAPP_CLOUD, WhatsAppCloudProvider } from './providers.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import type { InboundMessage } from './whatsapp-webhook.js';

// The inbox (MSG-05, ADR-545): what customers write to a shop on WhatsApp, kept for its staff to
// read, a conversation for each customer's number. A message to a shop's own number is that
// shop's; one to Hatti's shared number is the shop's whose message it answers, else the one that
// last wrote to the number; one no shop wrote to is no one's, and is not kept. The webhook works
// with the application's login, finding the shop through functions that see no shop's rows. Staff
// answer in their own words within the day WhatsApp allows, from the number the customer wrote to
// (ADR-546): sent at once, and followed to delivery as the webhook says.

/** How long after a customer last wrote WhatsApp lets the shop answer them freely. */
export const CONVERSATION_WINDOW_MS = 24 * 3_600_000;

/** The longest reply WhatsApp takes, in characters. */
export const REPLY_MAX_LENGTH = 4096;

export type ConversationStatusValue = 'open' | 'closed';
export type ConversationDirectionValue = 'inbound' | 'outbound';
export type ReplyStatusValue = 'sent' | 'delivered' | 'read' | 'failed';

/** A message of a conversation, as the shop's staff read it. */
export interface ConversationMessageRecord {
  id: string;
  direction: ConversationDirectionValue;
  body: string | null;
  mediaKind: string | null;
  at: Date;
  /** How a reply went, as WhatsApp says; null for what the customer wrote. */
  status: ReplyStatusValue | null;
  /** Why WhatsApp could not deliver a reply. */
  error: string | null;
}

/**
 * Meta's Graph API as replies go through it, and Hatti's shared number with its token: null
 * where it is not set up, as in development, and replies to it are refused.
 */
export interface WhatsAppReplySettings {
  baseUrl: string;
  version: string;
  shared: { phoneNumberId: string; accessToken: string } | null;
}

export const WHATSAPP_REPLIES = Symbol('WHATSAPP_REPLIES');

/** A conversation with a customer, as the inbox lists it. */
export interface ConversationRecord {
  id: string;
  channel: 'whatsapp';
  /** E.164: the API masks it as the caller may see it. */
  customerPhone: string;
  /** Whether the customer last wrote to the shop's own number, not Hatti's shared one. */
  viaOwnNumber: boolean;
  status: ConversationStatusValue;
  unread: number;
  lastMessageAt: Date;
  lastInboundAt: Date | null;
  createdAt: Date;
  lastMessage: ConversationMessageRecord | null;
  /** The account of the member of staff it is given to, to answer (ADR-759); null for no one. */
  assigneeId: string | null;
  /** When it last had a message, to the microsecond: where the next page starts. */
  lastMessageAtExactly: string;
}

export interface ConversationsListOptions {
  first: number;
  /** The last one of the page before: the next page starts after it. */
  after: { id: string; lastMessageAt: string } | null;
  /** Those with messages unread alone. */
  unread?: boolean;
  status?: ConversationStatusValue | null;
  /** Those given to this member of staff alone, by their account (ADR-759). */
  assigneeId?: string | null;
  /** Those given to no one alone. */
  unassigned?: boolean;
}

type ConversationRow = {
  id: string;
  customer_phone: string;
  via_phone_number_id: string | null;
  status: ConversationStatusValue;
  unread: number;
  last_message_at: string | Date;
  last_inbound_at: string | Date | null;
  created_at: string | Date;
  assignee_id: string | null;
  last_message_at_exactly: string;
  message_id: string | null;
  direction: ConversationDirectionValue | null;
  body: string | null;
  media_kind: string | null;
  at: string | Date | null;
  message_status: ReplyStatusValue | null;
  message_error: string | null;
};

type MessageRow = {
  id: string;
  direction: ConversationDirectionValue;
  body: string | null;
  media_kind: string | null;
  at: string | Date;
  status: ReplyStatusValue | null;
  error: string | null;
};

/** What WhatsApp's statuses may move a reply on from: never back, and failed only undelivered. */
const STATUS_FROM: Record<StatusUpdate['status'], readonly ReplyStatusValue[]> = {
  sent: [],
  delivered: ['sent'],
  read: ['sent', 'delivered'],
  failed: ['sent'],
};

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: Database,
    @Optional()
    @Inject(WHATSAPP_REPLIES)
    private readonly replies: WhatsAppReplySettings | null = null,
    @Optional() private readonly accounts: WhatsAppAccountsService | null = null,
  ) {}

  /**
   * Keeps `message`, which a customer wrote on WhatsApp, in the conversation of the shop it is
   * for, opening it again if it was closed: once, however often WhatsApp's webhook names it. The
   * shop it was for; null for a message no shop's.
   */
  async recordInbound(message: InboundMessage): Promise<string | null> {
    if (message.text === null && message.mediaKind === null) return null;
    const found = await this.#shopOf(message);
    if (!found) return null;
    const { shopId, own } = found;
    await this.db.tenant(shopId, async (tx) => {
      const at = message.at.toISOString();
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO messaging.conversations
               (shop_id, customer_phone, via_phone_number_id, last_message_at, last_inbound_at)
        VALUES (${shopId}, ${message.from}, ${own ? message.to : null}, ${at}, ${at})
            ON CONFLICT (shop_id, channel, customer_phone) DO UPDATE
                   SET via_phone_number_id = excluded.via_phone_number_id, status = 'open',
                       last_message_at = greatest(messaging.conversations.last_message_at,
                                                  excluded.last_message_at),
                       last_inbound_at = greatest(messaging.conversations.last_inbound_at,
                                                  excluded.last_inbound_at)
        RETURNING id`);
      const conversationId = rows[0]!.id;
      const kept = await tx.execute<{ id: string }>(sql`
        INSERT INTO messaging.conversation_messages
               (shop_id, conversation_id, direction, body, media_kind, provider_message_id, at)
        VALUES (${shopId}, ${conversationId}, 'inbound', ${message.text}, ${message.mediaKind},
                ${message.id}, ${at})
            ON CONFLICT (shop_id, provider_message_id) WHERE provider_message_id IS NOT NULL
            DO NOTHING
        RETURNING id`);
      const messageId = kept.rows[0]?.id;
      if (!messageId) return;
      await tx.execute(sql`
        UPDATE messaging.conversations SET unread = unread + 1
         WHERE shop_id = ${shopId} AND id = ${conversationId}`);
      await appendEvent<ConversationMessageReceivedPayload>(tx, shopId, {
        type: MessagingEvents.ConversationMessageReceived,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { messageId, at },
      });
    });
    return shopId;
  }

  /** The shop's conversations, the latest written first, a page at a time. */
  async list(
    tenant: TenantContext,
    options: ConversationsListOptions,
  ): Promise<Page<ConversationRecord>> {
    const { after } = options;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ConversationRow>(sql`
        ${conversationSelect(tenant.shopId)}
           ${options.unread ? sql`AND c.unread > 0` : sql``}
           ${options.status ? sql`AND c.status = ${options.status}` : sql``}
           ${options.assigneeId ? sql`AND c.assignee_id = ${options.assigneeId}` : sql``}
           ${options.unassigned ? sql`AND c.assignee_id IS NULL` : sql``}
           ${
             after
               ? sql`AND (c.last_message_at, c.id)
                         < (${after.lastMessageAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY c.last_message_at DESC, c.id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map(toConversation),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** The shop's conversation `id`; null if it has none. */
  async get(tenant: TenantContext, id: string): Promise<ConversationRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => conversationIn(tx, tenant.shopId, id));
  }

  /** How many of the shop's conversations have messages its staff have not read. */
  async unreadCount(tenant: TenantContext): Promise<number> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.conversations
         WHERE shop_id = ${tenant.shopId} AND unread > 0`),
    );
    return rows[0]!.count;
  }

  /**
   * The conversation's messages, the latest first, `first` at a time, those before `before` when
   * given: the one the page before ended at.
   */
  async messages(
    tenant: TenantContext,
    conversationId: string,
    options: { first: number; before: string | null },
  ): Promise<Page<ConversationMessageRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<MessageRow>(sql`
        SELECT m.id, m.direction, m.body, m.media_kind, m.at, m.status, m.error
          FROM messaging.conversation_messages m
         WHERE m.shop_id = ${tenant.shopId} AND m.conversation_id = ${conversationId}
           ${
             options.before
               ? sql`AND (m.at, m.id) < (SELECT b.at, b.id FROM messaging.conversation_messages b
                                         WHERE b.shop_id = ${tenant.shopId}
                                           AND b.id = ${options.before})`
               : sql``
           }
         ORDER BY m.at DESC, m.id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map(toMessage),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** Marks the conversation's messages read: the conversation after; null if it has none. */
  async markRead(tenant: TenantContext, id: string): Promise<ConversationRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE messaging.conversations SET unread = 0
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return conversationIn(tx, tenant.shopId, id);
    });
  }

  /**
   * Gives the conversation to a member of staff to answer, by their account, or to no one
   * (ADR-759): the conversation after. Those who may not take conversations from others
   * (`fromOthers`) take only one no one has, and give back only their own.
   */
  async assign(
    tenant: TenantContext,
    id: string,
    assigneeId: string | null,
    options: { fromOthers: boolean },
  ): Promise<MutationResult<ConversationRecord>> {
    const self = tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await conversationIn(tx, tenant.shopId, id);
      if (!found) return failOne<never>(['id'], 'NOT_FOUND', 'No such conversation');
      if (found.assigneeId === assigneeId) return { ok: true as const, value: found };
      if (!options.fromOthers && found.assigneeId !== null && found.assigneeId !== self) {
        return failOne<never>(
          ['id'],
          'INVALID',
          'The conversation is given to someone else; an owner or manager gives it to another',
        );
      }
      await tx.execute(sql`
        UPDATE messaging.conversations
           SET assignee_id = ${assigneeId},
               assigned_at = ${assigneeId ? sql`now()` : sql`NULL`}
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return { ok: true as const, value: (await conversationIn(tx, tenant.shopId, id))! };
    });
  }

  /**
   * Gives back to no one the conversations given to a member of staff who left the shop, for
   * others to take (ADR-759): how many.
   */
  async release(tenant: TenantContext, staffMemberId: string): Promise<number> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        UPDATE messaging.conversations SET assignee_id = NULL, assigned_at = NULL
         WHERE shop_id = ${tenant.shopId} AND assignee_id = ${staffMemberId}
        RETURNING id`),
    );
    return rows.length;
  }

  /**
   * Closes the conversation, or opens it again: the conversation after; null if it has none. The
   * customer writing again opens it again.
   */
  async setStatus(
    tenant: TenantContext,
    id: string,
    status: ConversationStatusValue,
  ): Promise<ConversationRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE messaging.conversations
           SET status = ${status}, unread = CASE WHEN ${status} = 'closed' THEN 0 ELSE unread END
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return conversationIn(tx, tenant.shopId, id);
    });
  }

  /**
   * Answers the customer in `body`, from the number they last wrote to, while WhatsApp lets the
   * shop write freely: within a day of their last message. Sent at once; kept, and the
   * conversation read, once WhatsApp takes it. What WhatsApp refuses is not kept.
   */
  async reply(
    tenant: TenantContext,
    id: string,
    body: string,
    now: Date = new Date(),
  ): Promise<
    MutationResult<{ conversation: ConversationRecord; message: ConversationMessageRecord }>
  > {
    const text = body.trim();
    if (!text) return failOne(['body'], 'BLANK', 'Write something to send');
    if (text.length > REPLY_MAX_LENGTH) {
      return failOne(['body'], 'TOO_LONG', `A reply is at most ${REPLY_MAX_LENGTH} characters`);
    }
    const found = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{
        customer_phone: string;
        via_phone_number_id: string | null;
        last_inbound_at: string | Date | null;
      }>(sql`
        SELECT customer_phone, via_phone_number_id, last_inbound_at
          FROM messaging.conversations
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`),
    );
    const conversation = found.rows[0];
    if (!conversation) return failOne(['id'], 'NOT_FOUND', 'No such conversation');
    const lastInbound = toDateOrNull(conversation.last_inbound_at);
    if (!lastInbound || now.getTime() - lastInbound.getTime() >= CONVERSATION_WINDOW_MS) {
      return failOne(
        ['id'],
        'WINDOW_CLOSED',
        'WhatsApp lets a shop answer only within a day of the customer’s last message',
      );
    }
    const provider = await this.#replyingNumber(tenant.shopId, conversation.via_phone_number_id);
    if (!provider) {
      return failOne(
        ['id'],
        'UNAVAILABLE',
        conversation.via_phone_number_id
          ? 'The number the customer wrote to is no longer connected'
          : 'WhatsApp is not set up to send replies',
      );
    }
    const sent = await provider.sendText(conversation.customer_phone, text);
    if (!sent.ok) {
      return failOne(['body'], sent.outcome === 'retry' ? 'UNAVAILABLE' : 'NOT_SENT', sent.error);
    }
    const actor = actorColumnsOf(tenant.actor);
    return {
      ok: true,
      value: await this.db.tenant(tenant.shopId, async (tx) => {
        const at = now.toISOString();
        const { rows } = await tx.execute<MessageRow>(sql`
          INSERT INTO messaging.conversation_messages
                 (shop_id, conversation_id, direction, body, provider_message_id, at, status,
                  actor_kind, actor_id)
          VALUES (${tenant.shopId}, ${id}, 'outbound', ${text}, ${sent.providerMessageId}, ${at},
                  'sent', ${actor.actorKind}, ${actor.actorId})
          RETURNING id, direction, body, media_kind, at, status, error`);
        const message = rows[0]!;
        await tx.execute(sql`
          UPDATE messaging.conversations
             SET unread = 0, last_message_at = greatest(last_message_at, ${at}::timestamptz)
           WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
        await appendEvent<ConversationRepliedPayload>(tx, tenant.shopId, {
          type: MessagingEvents.ConversationReplied,
          aggregateType: 'conversation',
          aggregateId: id,
          payload: { messageId: message.id, at },
        });
        return {
          conversation: (await conversationIn(tx, tenant.shopId, id))!,
          message: toMessage(message),
        };
      }),
    };
  }

  /**
   * How the replies WhatsApp's webhook names went: delivered, then read; failed only before
   * delivery. Each found by its ID across shops, then changed as its shop. Those not found are
   * given back, for the messages' own statuses or none.
   */
  async recordStatuses(updates: readonly StatusUpdate[]): Promise<StatusUpdate[]> {
    if (updates.length === 0) return [];
    const { rows } = await this.db.app.execute<{
      shop_id: string;
      message_id: string;
      provider_message_id: string;
    }>(sql`
      SELECT shop_id, message_id, provider_message_id
        FROM messaging.resolve_conversation_messages(
               ${sql.param(updates.map((update) => update.providerMessageId))}::text[])`);
    const found = new Map(rows.map((row) => [row.provider_message_id, row]));
    for (const update of updates) {
      const reply = found.get(update.providerMessageId);
      if (!reply) continue;
      const from = STATUS_FROM[update.status];
      if (from.length === 0) continue;
      await this.db.tenant(reply.shop_id, (tx) =>
        tx.execute(sql`
          UPDATE messaging.conversation_messages
             SET status = ${update.status},
                 error = CASE WHEN ${update.status} = 'failed'
                              THEN ${(update.error ?? 'WhatsApp could not deliver it').slice(0, 1_000)}
                              ELSE error END
           WHERE shop_id = ${reply.shop_id} AND id = ${reply.message_id}
             AND status = ANY(${sql.param(from)}::text[])`),
      );
    }
    return updates.filter((update) => !found.has(update.providerMessageId));
  }

  /**
   * The number a reply goes from: the shop's own, where the customer last wrote to it and it is
   * still connected; Hatti's shared number where they wrote to that. None otherwise.
   */
  async #replyingNumber(
    shopId: string,
    viaPhoneNumberId: string | null,
  ): Promise<WhatsAppCloudProvider | null> {
    if (!this.replies) return null;
    const { baseUrl, version } = this.replies;
    if (viaPhoneNumberId) {
      const sender = await this.accounts?.senderOf(shopId);
      return sender?.phoneNumberId === viaPhoneNumberId
        ? new WhatsAppCloudProvider({
            baseUrl,
            version,
            phoneNumberId: sender.phoneNumberId,
            accessToken: sender.accessToken,
            shopNumber: true,
          })
        : null;
    }
    const { shared } = this.replies;
    return shared && new WhatsAppCloudProvider({ baseUrl, version, ...shared });
  }

  /** The shop a customer's message is for, and whether it was written to its own number. */
  async #shopOf(message: InboundMessage): Promise<{ shopId: string; own: boolean } | null> {
    if (message.to) {
      const { rows } = await this.db.app.execute<{ shop_id: string }>(
        sql`SELECT shop_id FROM messaging.resolve_whatsapp_number(${message.to})`,
      );
      if (rows[0]) return { shopId: rows[0].shop_id, own: true };
    }
    if (message.replyTo) {
      const { rows } = await this.db.app.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM messaging.resolve_provider_messages(
                 ${WHATSAPP_CLOUD}, ARRAY[${message.replyTo}]::text[])`);
      if (rows[0]) return { shopId: rows[0].shop_id, own: false };
    }
    const { rows } = await this.db.app.execute<{ shop_id: string }>(
      sql`SELECT shop_id FROM messaging.resolve_last_sender('whatsapp', ${message.from})`,
    );
    return rows[0] ? { shopId: rows[0].shop_id, own: false } : null;
  }
}

function conversationSelect(shopId: string) {
  return sql`
    SELECT c.id, c.customer_phone, c.via_phone_number_id, c.status, c.unread, c.last_message_at,
           c.last_inbound_at, c.created_at, c.assignee_id,
           ${exactTime(sql`c.last_message_at`)} AS last_message_at_exactly,
           m.id AS message_id, m.direction, m.body, m.media_kind, m.at,
           m.status AS message_status, m.error AS message_error
      FROM messaging.conversations c
      LEFT JOIN LATERAL (
        SELECT l.id, l.direction, l.body, l.media_kind, l.at, l.status, l.error
          FROM messaging.conversation_messages l
         WHERE l.shop_id = c.shop_id AND l.conversation_id = c.id
         ORDER BY l.at DESC, l.id DESC LIMIT 1) m ON true
     WHERE c.shop_id = ${shopId}`;
}

async function conversationIn(
  tx: Tx,
  shopId: string,
  id: string,
): Promise<ConversationRecord | null> {
  const { rows } = await tx.execute<ConversationRow>(sql`
    ${conversationSelect(shopId)} AND c.id = ${id}`);
  return rows[0] ? toConversation(rows[0]) : null;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    channel: 'whatsapp',
    customerPhone: row.customer_phone,
    viaOwnNumber: row.via_phone_number_id !== null,
    status: row.status,
    unread: row.unread,
    lastMessageAt: toDate(row.last_message_at),
    lastInboundAt: toDateOrNull(row.last_inbound_at),
    createdAt: toDate(row.created_at),
    assigneeId: row.assignee_id,
    lastMessage:
      row.message_id && row.direction && row.at
        ? toMessage({
            id: row.message_id,
            direction: row.direction,
            body: row.body,
            media_kind: row.media_kind,
            at: row.at,
            status: row.message_status,
            error: row.message_error,
          })
        : null,
    lastMessageAtExactly: row.last_message_at_exactly,
  };
}

function toMessage(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    direction: row.direction,
    body: row.body,
    mediaKind: row.media_kind,
    at: toDate(row.at),
    status: row.status,
    error: row.error,
  };
}

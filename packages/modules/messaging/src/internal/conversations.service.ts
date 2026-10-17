import type { TenantContext } from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MessagingEvents, type ConversationMessageReceivedPayload } from './events.js';
import type { Page } from './messages.service.js';
import { WHATSAPP_CLOUD } from './providers.js';
import type { InboundMessage } from './whatsapp-webhook.js';

// The inbox (MSG-05, ADR-545): what customers write to a shop on WhatsApp, kept for its staff to
// read, a conversation for each customer's number. A message to a shop's own number is that
// shop's; one to Hatti's shared number is the shop's whose message it answers, else the one that
// last wrote to the number; one no shop wrote to is no one's, and is not kept. The webhook works
// with the application's login, finding the shop through functions that see no shop's rows.

/** How long after a customer last wrote WhatsApp lets the shop answer them freely. */
export const CONVERSATION_WINDOW_MS = 24 * 3_600_000;

export type ConversationStatusValue = 'open' | 'closed';
export type ConversationDirectionValue = 'inbound' | 'outbound';

/** A message of a conversation, as the shop's staff read it. */
export interface ConversationMessageRecord {
  id: string;
  direction: ConversationDirectionValue;
  body: string | null;
  mediaKind: string | null;
  at: Date;
}

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
  last_message_at_exactly: string;
  message_id: string | null;
  direction: ConversationDirectionValue | null;
  body: string | null;
  media_kind: string | null;
  at: string | Date | null;
};

type MessageRow = {
  id: string;
  direction: ConversationDirectionValue;
  body: string | null;
  media_kind: string | null;
  at: string | Date;
};

@Injectable()
export class ConversationsService {
  constructor(private readonly db: Database) {}

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
        SELECT m.id, m.direction, m.body, m.media_kind, m.at
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
           c.last_inbound_at, c.created_at,
           ${exactTime(sql`c.last_message_at`)} AS last_message_at_exactly,
           m.id AS message_id, m.direction, m.body, m.media_kind, m.at
      FROM messaging.conversations c
      LEFT JOIN LATERAL (
        SELECT l.id, l.direction, l.body, l.media_kind, l.at
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
    lastMessage:
      row.message_id && row.direction && row.at
        ? toMessage({
            id: row.message_id,
            direction: row.direction,
            body: row.body,
            media_kind: row.media_kind,
            at: row.at,
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
  };
}

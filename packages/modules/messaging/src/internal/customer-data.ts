import { shopProfile } from '@hatti/api';
import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { toDate, toDateOrNull } from '@hatti/db';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { queueMessageIn } from './messages.service.js';

/**
 * Messages' part in merging, erasing and exporting customers (ADR-146). A merged duplicate's
 * messages become the customer's. An erased customer's messages go: they hold their number, or
 * their email (ADR-181), and name. Their numbers' opt-outs stay, so the shop never writes to them
 * again by mistake. Their wishes to hear when a product is back in stock (ADR-429) go too, and
 * their numbers' conversations with the shop (ADR-545). A customer's own file has the messages
 * sent them, their opt-outs, those wishes and what they wrote to the shop. A shopper who asked for
 * their erasure from their account is told once it is done (ADR-582), by a message forgotten once
 * sent, so that their number is kept no longer than it takes to tell them.
 */
export const MESSAGING_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'messaging',

  async erasureBlockers() {
    return [];
  },

  async merge(tx, shopId, fromId, intoId) {
    await tx.execute(sql`
      UPDATE messaging.messages SET customer_id = ${intoId}
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  async erase(tx, shopId, customer) {
    await tx.execute(sql`
      DELETE FROM messaging.messages
       WHERE shop_id = ${shopId}
         AND (customer_id = ${customer.id}
              OR recipient = ANY(${sql.param(customer.phones)}::text[])
              OR (channel = 'email' AND recipient = lower(${customer.email}::text)))`);
    await tx.execute(sql`
      DELETE FROM messaging.stock_watches
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])`);
    // What they wrote to the shop, and its answers (ADR-545).
    await tx.execute(sql`
      DELETE FROM messaging.conversations
       WHERE shop_id = ${shopId} AND customer_phone = ANY(${sql.param(customer.phones)}::text[])`);
  },

  async erased(tx, shopId, notice) {
    await queueMessageIn(tx, shopId, {
      kind: 'erasure_done',
      recipient: notice.phone,
      language: notice.language,
      channel: 'whatsapp',
      dedupeKey: `erasure_done:${notice.customerId}`,
      variables: { shop: (await shopProfile(tx, shopId)).name },
    });
  },

  async export(tx, shopId, customer) {
    const { rows: messages } = await tx.execute<{
      kind: string;
      channel: string;
      recipient: string;
      language: string;
      variables: Record<string, string>;
      status: string;
      sent_at: string | Date | null;
      delivered_at: string | Date | null;
      read_at: string | Date | null;
      created_at: string | Date;
    }>(sql`
      SELECT kind, channel, recipient, language, variables, status, sent_at, delivered_at,
             read_at, created_at
        FROM messaging.messages
       WHERE shop_id = ${shopId}
         AND (customer_id = ${customer.id}
              OR recipient = ANY(${sql.param(customer.phones)}::text[])
              OR (channel = 'email' AND recipient = lower(${customer.email}::text)))
       ORDER BY created_at, id`);
    const { rows: optOuts } = await tx.execute<{
      channel: string;
      recipient: string;
      said: string | null;
      created_at: string | Date;
    }>(sql`
      SELECT channel, recipient, said, created_at FROM messaging.opt_outs
       WHERE shop_id = ${shopId} AND recipient = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY created_at`);
    const { rows: watches } = await tx.execute<{
      variant_id: string;
      phone: string;
      created_at: string | Date;
      notified_at: string | Date | null;
    }>(sql`
      SELECT variant_id, phone, created_at, notified_at FROM messaging.stock_watches
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY created_at, id`);
    const { rows: conversation } = await tx.execute<{
      customer_phone: string;
      direction: string;
      body: string | null;
      media_kind: string | null;
      at: string | Date;
    }>(sql`
      SELECT c.customer_phone, m.direction, m.body, m.media_kind, m.at
        FROM messaging.conversation_messages m
        JOIN messaging.conversations c ON c.shop_id = m.shop_id AND c.id = m.conversation_id
       WHERE m.shop_id = ${shopId} AND c.customer_phone = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY m.at, m.id`);
    return {
      // What they wrote to the shop on WhatsApp, and its answers (ADR-545).
      conversationMessages: conversation.map((row) => ({
        number: row.customer_phone,
        direction: row.direction,
        said: row.body,
        held: row.media_kind,
        at: toDate(row.at),
      })),
      messages: messages.map((row) => ({
        kind: row.kind,
        channel: row.channel,
        to: row.recipient,
        language: row.language,
        said: row.variables,
        status: row.status,
        queuedAt: toDate(row.created_at),
        sentAt: toDateOrNull(row.sent_at),
        deliveredAt: toDateOrNull(row.delivered_at),
        readAt: toDateOrNull(row.read_at),
      })),
      messageOptOuts: optOuts.map((row) => ({
        channel: row.channel,
        number: row.recipient,
        said: row.said,
        at: toDate(row.created_at),
      })),
      backInStockRequests: watches.map((row) => ({
        variantId: row.variant_id,
        number: row.phone,
        askedAt: toDate(row.created_at),
        toldAt: toDateOrNull(row.notified_at),
      })),
    };
  },
};

/** Adds messages to merges, erasure and exports when the application starts. */
@Injectable()
export class MessagingCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(MESSAGING_CUSTOMER_DATA);
  }
}

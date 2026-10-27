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
 * sent, so that their number is kept no longer than it takes to tell them. What they wrote through
 * the online store's contact form, from their numbers or email, goes too, and is in their file
 * (ADR-589). A merged duplicate's referral code goes, unless the customer has none, and its
 * referrals become the customer's; an erased customer's code and referrals go (ADR-807).
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
    await tx.execute(sql`
      UPDATE messaging.referral_codes SET customer_id = ${intoId}
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}
         AND NOT EXISTS (SELECT 1 FROM messaging.referral_codes
                          WHERE shop_id = ${shopId} AND customer_id = ${intoId})`);
    await tx.execute(sql`
      DELETE FROM messaging.referral_codes
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
    await tx.execute(sql`
      UPDATE messaging.referrals
         SET referrer_id = CASE WHEN referrer_id = ${fromId} THEN ${intoId}::uuid
                                ELSE referrer_id END,
             friend_id = CASE WHEN friend_id = ${fromId} THEN ${intoId}::uuid ELSE friend_id END
       WHERE shop_id = ${shopId} AND ${fromId} IN (referrer_id, friend_id)`);
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
    // Their referral code, and the referrals they made or were made (ADR-807).
    await tx.execute(sql`
      DELETE FROM messaging.referral_codes
       WHERE shop_id = ${shopId} AND customer_id = ${customer.id}`);
    await tx.execute(sql`
      DELETE FROM messaging.referrals
       WHERE shop_id = ${shopId} AND ${customer.id} IN (referrer_id, friend_id)`);
    // What they wrote through the contact form (ADR-589).
    await tx.execute(sql`
      DELETE FROM messaging.contact_messages
       WHERE shop_id = ${shopId}
         AND (phone = ANY(${sql.param(customer.phones)}::text[])
              OR email = lower(${customer.email}::text))`);
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
    const { rows: contactMessages } = await tx.execute<{
      name: string | null;
      email: string | null;
      phone: string | null;
      body: string;
      fields: Record<string, string>;
      page: string | null;
      created_at: string | Date;
    }>(sql`
      SELECT name, email, phone, body, fields, page, created_at FROM messaging.contact_messages
       WHERE shop_id = ${shopId}
         AND (phone = ANY(${sql.param(customer.phones)}::text[])
              OR email = lower(${customer.email}::text))
       ORDER BY id`);
    return {
      // What they wrote through the online store's contact form (ADR-589).
      contactMessages: contactMessages.map((row) => ({
        name: row.name,
        email: row.email,
        number: row.phone,
        said: row.body,
        fields: row.fields,
        page: row.page,
        at: toDate(row.created_at),
      })),
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

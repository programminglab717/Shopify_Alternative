import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { toDate, toDateOrNull } from '@hatti/db';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * Messages' part in merging, erasing and exporting customers (ADR-146). A merged duplicate's
 * messages become the customer's. An erased customer's messages go: they hold their number and
 * name. Their numbers' opt-outs stay, so the shop never writes to them again by mistake. A
 * customer's own file has the messages sent them and their opt-outs.
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
              OR recipient = ANY(${sql.param(customer.phones)}::text[]))`);
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
              OR recipient = ANY(${sql.param(customer.phones)}::text[]))
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
    return {
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

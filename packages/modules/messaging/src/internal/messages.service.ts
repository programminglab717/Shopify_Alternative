import type { TenantContext } from '@hatti/api';
import { Database, exactTime, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MessageCharges, chargedFor, messageCostOf } from './charges.js';
import { emailStatusOf } from './email-events.js';
import { MessagingEvents, type MessageRepliedPayload } from './events.js';
import { SES_EMAIL, WHATSAPP_CLOUD, type MessageChannel } from './providers.js';
import { settingsIn } from './settings.service.js';
import {
  ALWAYS_SENT,
  EMAILED_KINDS,
  SECRET_KINDS,
  type MessageKind,
  type MessageLanguage,
  type MessageVariables,
} from './templates.js';

// Each message a shop's customers are sent waits in messaging.messages (ADR-146) until a sender
// in the worker takes it: queued once by its key, however often its event comes; tried again
// while its channel cannot take it yet; sent by SMS instead when WhatsApp cannot deliver it; and
// followed to delivery through WhatsApp's webhooks. The news of an order goes by email too, to the
// address its customer gave (ADR-181): a copy of its own, queued with it.

export const MESSAGE_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** A message to queue: what it says, and to whom. */
export interface MessageToQueue {
  kind: MessageKind;
  /** In E.164; an address, for an email (ADR-195). */
  recipient: string;
  variables: MessageVariables;
  orderId?: string | null;
  customerId?: string | null;
  /** Queued once by it: "order_placed:<order>". */
  dedupeKey: string;
  /** The channel it must go by, as one a shopper chose; the shop's routing's otherwise. */
  channel?: MessageChannel;
  /**
   * The customer's email, as their order has it (ADR-181): the news of an order goes there too,
   * as a copy queued with the message, once by its key and ":email".
   */
  email?: string | null;
  /**
   * The language of the person it is for, where they chose their own, as a member of staff does
   * (ADR-194); the shop's otherwise.
   */
  language?: MessageLanguage | null;
}

/** A message the sender took to send. */
export interface ClaimedMessage {
  id: string;
  kind: MessageKind;
  channel: MessageChannel;
  recipient: string;
  language: MessageLanguage;
  variables: MessageVariables;
  /** Tries so far, this one among them. */
  attempts: number;
  createdAt: Date;
}

/** How sending a claimed message went. */
export type MessageOutcome =
  | { id: string; status: 'sent'; provider: string; providerMessageId: string }
  | { id: string; status: 'pending'; error: string; nextAttemptAt: Date }
  /** `replace`: an SMS goes in its place. */
  | { id: string; status: 'failed'; error: string; replace: boolean }
  | { id: string; status: 'skipped'; error: string };

/** A message as the shop's list shows it. */
export interface MessageRecord {
  id: string;
  kind: MessageKind;
  channel: MessageChannel;
  recipient: string;
  language: MessageLanguage;
  status: MessageStatus;
  attempts: number;
  orderId: string | null;
  customerId: string | null;
  error: string | null;
  /** The WhatsApp message it went in place of: an SMS's. */
  replacesId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  /** When it was queued, to the microsecond: where the next page starts. */
  createdAtExactly: string;
}

export interface MessagesListOptions {
  first: number;
  after: { id: string; createdAt: string } | null;
  status?: MessageStatus | null;
  orderId?: string | null;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

/** What WhatsApp's webhook said of a message it was sent. */
export interface StatusUpdate {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  error?: string | null;
}

/**
 * Notifications that are news alone: by SMS where the shop routes economically (07 §2.3). Those
 * asking for an answer, and answers, stay on WhatsApp.
 */
const INFORMATIONAL: ReadonlySet<MessageKind> = new Set([
  'order_placed',
  'order_confirmed',
  'order_shipped',
  'order_out_for_delivery',
  'order_delivered',
  'order_cancelled',
  'order_paid',
  'order_advance_paid',
  'store_credit_given',
  'store_credit_expiring',
]);

type MessageRow = {
  id: string;
  kind: MessageKind;
  channel: MessageChannel;
  recipient: string;
  language: MessageLanguage;
  status: MessageStatus;
  attempts: number;
  order_id: string | null;
  customer_id: string | null;
  error: string | null;
  replaces: string | null;
  sent_at: string | Date | null;
  delivered_at: string | Date | null;
  read_at: string | Date | null;
  created_at: string | Date;
  created_at_exactly: string;
};

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: Database,
    /** What the shop's messages are paid from (ADR-155); without it, nothing is charged. */
    @Optional() private readonly charges?: MessageCharges,
  ) {}

  /**
   * Queues a message to the shop's customer, once by its key: by WhatsApp, or by SMS where the
   * shop routes updates economically, in the shop's language, or the recipient's own where it is
   * given (ADR-194); and the news of an order to their email too, when they gave one (ADR-181).
   * Nothing for a notification the shop turned off. Its ID, if it was queued now; null if it was
   * not, or was before.
   */
  async queueIn(tx: Tx, shopId: string, message: MessageToQueue): Promise<string | null> {
    const settings = await settingsIn(tx, shopId);
    if (settings.disabled.includes(message.kind) && !ALWAYS_SENT.includes(message.kind)) {
      return null;
    }
    const language = message.language ?? settings.language;
    const channel: MessageChannel =
      message.channel ??
      (settings.routing === 'economy' && INFORMATIONAL.has(message.kind) ? 'sms' : 'whatsapp');
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO messaging.messages
             (shop_id, kind, channel, recipient, language, variables, order_id, customer_id,
              dedupe_key)
      VALUES (${shopId}, ${message.kind}, ${channel}, ${message.recipient}, ${language},
              ${JSON.stringify(message.variables)}::jsonb, ${message.orderId ?? null},
              ${message.customerId ?? null}, ${message.dedupeKey})
          ON CONFLICT (shop_id, dedupe_key) DO NOTHING
      RETURNING id`);
    const id = rows[0]?.id ?? null;
    const email = emailOf(message.email);
    // Its copy goes with it: queued now, or not again.
    if (id && email && EMAILED_KINDS.includes(message.kind)) {
      await tx.execute(sql`
        INSERT INTO messaging.messages
               (shop_id, kind, channel, recipient, language, variables, order_id, customer_id,
                dedupe_key)
        VALUES (${shopId}, ${message.kind}, 'email', ${email}, ${language},
                ${JSON.stringify(message.variables)}::jsonb, ${message.orderId ?? null},
                ${message.customerId ?? null}, ${`${message.dedupeKey}:email`})
            ON CONFLICT (shop_id, dedupe_key) DO NOTHING`);
    }
    return id;
  }

  /** {@link queueIn} in a transaction of its own. */
  async queue(shopId: string, message: MessageToQueue): Promise<string | null> {
    return this.db.tenant(shopId, (tx) => this.queueIn(tx, shopId, message));
  }

  /**
   * Gives a message still to go its link, made once it was queued, so a message queued twice
   * makes one (ADR-147); and its email's copy the same (ADR-181).
   */
  async linkIn(tx: Tx, shopId: string, id: string, url: string): Promise<void> {
    await tx.execute(sql`
      UPDATE messaging.messages m
         SET variables = m.variables || jsonb_build_object('url', ${url}::text)
        FROM messaging.messages queued
       WHERE queued.shop_id = ${shopId} AND queued.id = ${id}
         AND m.shop_id = ${shopId} AND m.status = 'pending'
         AND (m.id = queued.id
              OR (m.channel = 'email' AND m.dedupe_key = queued.dedupe_key || ':email'))`);
  }

  /**
   * The links the order's messages carried, the latest first: for the next to carry the same
   * (ADR-160).
   */
  async linksIn(tx: Tx, shopId: string, orderId: string): Promise<string[]> {
    const { rows } = await tx.execute<{ url: string }>(sql`
      SELECT variables ->> 'url' AS url FROM messaging.messages
       WHERE shop_id = ${shopId} AND order_id = ${orderId} AND variables ? 'url'
       ORDER BY created_at DESC, id DESC
       LIMIT 20`);
    return rows.map((row) => row.url);
  }

  /** What one of the shop's messages said, and of which order; null if it is gone. */
  async messageIn(
    tx: Tx,
    shopId: string,
    id: string,
  ): Promise<{ kind: MessageKind; orderId: string | null; variables: MessageVariables } | null> {
    const { rows } = await tx.execute<{
      kind: MessageKind;
      order_id: string | null;
      variables: MessageVariables;
    }>(sql`
      SELECT kind, order_id, variables FROM messaging.messages
       WHERE shop_id = ${shopId} AND id = ${id}`);
    const row = rows[0];
    return row ? { kind: row.kind, orderId: row.order_id, variables: row.variables } : null;
  }

  /** The shops with messages due at `at`: found with the system role, which sees all. */
  async dueShops(at: Date, limit = 100): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM messaging.messages
         WHERE status = 'pending' AND next_attempt_at <= ${at.toISOString()}
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Takes up to `limit` of the shop's messages due at `at`, the longest due first: each counts a
   * try, and is not due again for `leaseMs` unless settled before. No two senders take the same.
   */
  async claim(shopId: string, at: Date, limit: number, leaseMs: number): Promise<ClaimedMessage[]> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        kind: MessageKind;
        channel: MessageChannel;
        recipient: string;
        language: MessageLanguage;
        variables: MessageVariables;
        attempts: number;
        created_at: string | Date;
      }>(sql`
        -- Chosen once: a subquery in UPDATE's FROM may be run again, and take more.
        WITH due AS MATERIALIZED (
          SELECT id FROM messaging.messages
           WHERE shop_id = ${shopId} AND status = 'pending'
             AND next_attempt_at <= ${at.toISOString()}
           ORDER BY next_attempt_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE messaging.messages m
           SET attempts = m.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + leaseMs).toISOString()}
          FROM due
         WHERE m.shop_id = ${shopId} AND m.id = due.id
        RETURNING m.id, m.kind, m.channel, m.recipient, m.language, m.variables, m.attempts,
                  m.created_at`);
      return rows
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          channel: row.channel,
          recipient: row.recipient,
          language: row.language,
          variables: row.variables,
          attempts: row.attempts,
          createdAt: toDate(row.created_at),
        }))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    });
  }

  /** The recipients among `recipients` who asked the shop to stop on `channel`. */
  async optedOut(
    shopId: string,
    channel: MessageChannel,
    recipients: readonly string[],
  ): Promise<Set<string>> {
    if (recipients.length === 0) return new Set();
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ recipient: string }>(sql`
        SELECT recipient FROM messaging.opt_outs
         WHERE shop_id = ${shopId} AND channel = ${channel}
           AND recipient = ANY(${sql.param([...new Set(recipients)])}::text[])`),
    );
    return new Set(rows.map((row) => row.recipient));
  }

  /**
   * Records how sending went, for messages still pending: those the sender took. A message sent
   * is paid for from the shop's credit; a WhatsApp message failed with `replace` gets an SMS in
   * its place, once.
   */
  async settle(shopId: string, outcomes: readonly MessageOutcome[], at: Date): Promise<void> {
    if (outcomes.length === 0) return;
    await this.db.tenant(shopId, async (tx) => {
      for (const outcome of outcomes) {
        const set =
          outcome.status === 'sent'
            ? sql`status = 'sent', provider = ${outcome.provider},
                  provider_message_id = ${outcome.providerMessageId},
                  sent_at = ${at.toISOString()}, error = NULL`
            : outcome.status === 'pending'
              ? sql`next_attempt_at = ${outcome.nextAttemptAt.toISOString()},
                    error = ${outcome.error.slice(0, 1_000)}`
              : sql`status = ${outcome.status}, error = ${outcome.error.slice(0, 1_000)}`;
        const { rows } = await tx.execute<{
          channel: MessageChannel;
          kind: MessageKind;
          language: MessageLanguage;
          variables: MessageVariables;
        }>(sql`
          UPDATE messaging.messages SET ${set}
           WHERE shop_id = ${shopId} AND id = ${outcome.id} AND status = 'pending'
          RETURNING channel, kind, language, variables`);
        if (rows.length === 0 || outcome.status === 'pending') continue;
        if (outcome.status === 'sent' && this.charges && chargedFor(rows[0]!)) {
          await this.charges.chargeIn(tx, shopId, outcome.id, messageCostOf(rows[0]!));
        }
        if (outcome.status === 'failed' && outcome.replace) {
          await replaceWithSms(tx, shopId, outcome.id);
        }
        // A secret it held goes once it is sent, or will never be.
        await tx.execute(sql`
          UPDATE messaging.messages SET variables = variables - 'code'
           WHERE shop_id = ${shopId} AND id = ${outcome.id}
             AND (variables ->> 'code') IS NOT NULL`);
      }
    });
  }

  /**
   * Sends by SMS what WhatsApp's Cloud API took more than `afterMs` ago and has not delivered
   * (07 §1): the shopper may have no data, or no WhatsApp. Not what it took more than `withinMs`
   * ago, too late to help, nor what another provider took, which says nothing of delivery. How
   * many SMS were queued.
   */
  async replaceUndelivered(
    at: Date,
    afterMs: number,
    withinMs: number,
    limit = 500,
  ): Promise<number> {
    const before = new Date(at.getTime() - afterMs).toISOString();
    const since = new Date(at.getTime() - withinMs).toISOString();
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO messaging.messages
               (shop_id, kind, channel, recipient, language, variables, order_id, customer_id,
                dedupe_key, replaces)
        SELECT m.shop_id, m.kind, 'sms', m.recipient, m.language, m.variables, m.order_id,
               m.customer_id, m.dedupe_key || ':sms', m.id
          FROM messaging.messages m
         WHERE m.status = 'sent' AND m.channel = 'whatsapp' AND m.provider = ${WHATSAPP_CLOUD}
           AND m.sent_at <= ${before} AND m.sent_at > ${since}
           AND m.kind <> ALL(${sql.param([...SECRET_KINDS])}::text[])
           AND NOT EXISTS (SELECT 1 FROM messaging.messages r
                            WHERE r.shop_id = m.shop_id AND r.replaces = m.id)
         ORDER BY m.sent_at
         LIMIT ${limit}
            ON CONFLICT (shop_id, dedupe_key) DO NOTHING
        RETURNING id`);
      return rows.length;
    });
  }

  /**
   * What WhatsApp's webhook said of the messages it was sent, each moving only forward: sent,
   * delivered, then read; failed only before delivery, an SMS going in its place and what it was
   * charged given back, as Meta charges only what it delivers. Each message is
   * found by its ID across shops, then changed as its shop. Those not found are given back: a
   * status can come before the sender recorded the ID it was sent with. Of `provider`'s messages:
   * WhatsApp's, unless SES's word on emails is given (ADR-197).
   */
  async recordStatuses(
    updates: readonly StatusUpdate[],
    provider: string = WHATSAPP_CLOUD,
  ): Promise<{ changed: number; unmatched: StatusUpdate[] }> {
    const found = await this.#resolve(
      updates.map((update) => update.providerMessageId),
      provider,
    );
    const unmatched: StatusUpdate[] = [];
    const byShop = new Map<string, { id: string; update: StatusUpdate }[]>();
    for (const update of updates) {
      const messages = found.get(update.providerMessageId);
      if (!messages) unmatched.push(update);
      for (const { shopId, id } of messages ?? []) {
        byShop.set(shopId, [...(byShop.get(shopId) ?? []), { id, update }]);
      }
    }
    let changed = 0;
    for (const [shopId, shopUpdates] of byShop) {
      await this.db.tenant(shopId, async (tx) => {
        for (const { id, update } of shopUpdates) {
          const at = update.at.toISOString();
          const { rows } = await tx.execute(sql`
            UPDATE messaging.messages
               SET status = ${update.status},
                   delivered_at = CASE WHEN ${update.status} IN ('delivered', 'read')
                                       THEN coalesce(delivered_at, ${at}::timestamptz)
                                       ELSE delivered_at END,
                   read_at = CASE WHEN ${update.status} = 'read' THEN ${at}::timestamptz
                                  ELSE read_at END,
                   error = CASE WHEN ${update.status} = 'failed'
                                THEN ${(update.error ?? 'WhatsApp could not deliver it').slice(0, 1_000)}
                                ELSE error END
             WHERE shop_id = ${shopId} AND id = ${id}
               AND CASE ${update.status}
                     WHEN 'sent' THEN status = 'pending'
                     WHEN 'delivered' THEN status IN ('pending', 'sent')
                     WHEN 'read' THEN status IN ('pending', 'sent', 'delivered')
                     ELSE status IN ('pending', 'sent') END
            RETURNING id`);
          changed += rows.length;
          if (rows.length > 0 && update.status === 'failed') {
            await replaceWithSms(tx, shopId, id);
            await this.charges?.refundIn(tx, shopId, id);
          }
        }
      });
    }
    return { changed, unmatched };
  }

  /**
   * What SES said became of an email sent for a shop (ADR-197), from a notification of its SNS
   * topic: delivered, or failed for good, as WhatsApp's statuses move its messages. Whether a
   * message changed: none for Hatti's other emails, which are no shop's messages, nor for word
   * heard before.
   */
  async recordEmailEvent(message: string): Promise<boolean> {
    const update = emailStatusOf(message);
    if (!update) return false;
    return (await this.recordStatuses([update], SES_EMAIL)).changed > 0;
  }

  /**
   * The number asked to hear no more on `channel` (MSG-09): from the shop whose message it
   * replied to, or else the shop that last wrote to it there, as Hatti's shared number writes for
   * many. What was still to go to it goes no more. That shop, or null when none ever wrote.
   */
  async optOut(
    channel: MessageChannel,
    recipient: string,
    said: string,
    replyTo: string | null = null,
  ): Promise<string | null> {
    let shopId = replyTo ? (await this.#resolve([replyTo])).get(replyTo)?.[0]?.shopId : undefined;
    if (!shopId) {
      const { rows } = await this.db.app.execute<{ shop_id: string }>(
        sql`SELECT shop_id FROM messaging.resolve_last_sender(${channel}, ${recipient})`,
      );
      shopId = rows[0]?.shop_id;
    }
    if (!shopId) return null;
    const shop = shopId;
    await this.db.tenant(shop, async (tx) => {
      await tx.execute(sql`
        INSERT INTO messaging.opt_outs (shop_id, channel, recipient, said)
        VALUES (${shop}, ${channel}, ${recipient}, ${said.slice(0, 100)})
            ON CONFLICT DO NOTHING`);
      await tx.execute(sql`
        UPDATE messaging.messages
           SET status = 'skipped', error = 'Not sent: the customer asked the shop to stop'
         WHERE shop_id = ${shop} AND channel = ${channel} AND recipient = ${recipient}
           AND status = 'pending'`);
    });
    return shop;
  }

  /**
   * A customer pressed a button of the message WhatsApp knows as `replyTo` (ADR-147): recorded as
   * `message.replied` in its shop, for the worker to act on. Nothing for a message not found, or
   * not sent to them. Whether it was recorded.
   */
  async recordReply(reply: {
    replyTo: string;
    from: string;
    answer: string;
    at: Date;
  }): Promise<boolean> {
    const [found] = (await this.#resolve([reply.replyTo])).get(reply.replyTo) ?? [];
    if (!found) return false;
    return this.db.tenant(found.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        kind: string;
        order_id: string | null;
        recipient: string;
      }>(sql`
        SELECT kind, order_id, recipient FROM messaging.messages
         WHERE shop_id = ${found.shopId} AND id = ${found.id}`);
      const message = rows[0];
      if (!message || message.recipient !== reply.from) return false;
      await appendEvent<MessageRepliedPayload>(tx, found.shopId, {
        type: MessagingEvents.MessageReplied,
        aggregateType: 'message',
        aggregateId: found.id,
        payload: {
          kind: message.kind,
          orderId: message.order_id,
          answer: reply.answer,
          channel: 'whatsapp',
          at: reply.at.toISOString(),
        },
      });
      return true;
    });
  }

  /** The messages WhatsApp knows by `ids`, by ID: found in any shop, by the function made for it. */
  async #resolve(
    ids: readonly string[],
    provider: string = WHATSAPP_CLOUD,
  ): Promise<Map<string, { shopId: string; id: string }[]>> {
    const found = new Map<string, { shopId: string; id: string }[]>();
    const unique = [...new Set(ids)];
    for (let index = 0; index < unique.length; index += 100) {
      const { rows } = await this.db.app.execute<{
        shop_id: string;
        message_id: string;
        provider_message_id: string;
      }>(sql`
        SELECT shop_id, message_id, provider_message_id
          FROM messaging.resolve_provider_messages(
                 ${provider}, ${sql.param(unique.slice(index, index + 100))}::text[])`);
      for (const row of rows) {
        found.set(row.provider_message_id, [
          ...(found.get(row.provider_message_id) ?? []),
          { shopId: row.shop_id, id: row.message_id },
        ]);
      }
    }
    return found;
  }

  /** The shop's messages, the latest first, a page at a time. */
  async list(tenant: TenantContext, options: MessagesListOptions): Promise<Page<MessageRecord>> {
    const { after, status, orderId } = options;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<MessageRow>(sql`
        SELECT id, kind, channel, recipient, language, status, attempts, order_id, customer_id,
               error, replaces, sent_at, delivered_at, read_at, created_at,
               ${exactTime(sql`created_at`)} AS created_at_exactly
          FROM messaging.messages
         WHERE shop_id = ${tenant.shopId}
           ${status ? sql`AND status = ${status}` : sql``}
           ${orderId ? sql`AND order_id = ${orderId}` : sql``}
           ${
             after
               ? sql`AND (created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY created_at DESC, id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }
}

/**
 * `email` as a message's recipient: trimmed and lowercased, as the address the mailbox keeps; null
 * for none, or one not an address.
 */
function emailOf(email: string | null | undefined): string | null {
  const address = email?.trim().toLowerCase();
  return address && address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    ? address
    : null;
}

/**
 * Queues an SMS in place of the WhatsApp message `id`, once; not for one whose secret is gone, as
 * a code sent: a new one is asked for instead.
 */
async function replaceWithSms(tx: Tx, shopId: string, id: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO messaging.messages
           (shop_id, kind, channel, recipient, language, variables, order_id, customer_id,
            dedupe_key, replaces)
    SELECT shop_id, kind, 'sms', recipient, language, variables, order_id, customer_id,
           dedupe_key || ':sms', id
      FROM messaging.messages
     WHERE shop_id = ${shopId} AND id = ${id} AND channel = 'whatsapp'
       AND (kind <> ALL(${sql.param([...SECRET_KINDS])}::text[])
            OR (variables ->> 'code') IS NOT NULL)
        ON CONFLICT (shop_id, dedupe_key) DO NOTHING`);
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    recipient: row.recipient,
    language: row.language,
    status: row.status,
    attempts: row.attempts,
    orderId: row.order_id,
    customerId: row.customer_id,
    error: row.error,
    replacesId: row.replaces,
    sentAt: toDateOrNull(row.sent_at),
    deliveredAt: toDateOrNull(row.delivered_at),
    readAt: toDateOrNull(row.read_at),
    createdAt: toDate(row.created_at),
    createdAtExactly: row.created_at_exactly,
  };
}

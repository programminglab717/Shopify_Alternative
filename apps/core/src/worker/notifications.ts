import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import {
  MessagesService,
  type ClaimedMessage,
  type MessageChannel,
  type MessageKind,
  type MessageOutcome,
  type MessageProvider,
} from '@hatti/messaging/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import {
  OrderEvents,
  orderNotificationFactsIn,
  type FulfillmentCreatedPayload,
  type FulfillmentUpdatedPayload,
  type OrderCancelledPayload,
  type OrderCreatedPayload,
} from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Queues what a shop's customers are told about their orders (MSG-01, ADR-146), once each: their
 * order placed, each parcel shipped and delivered, and the order cancelled. A parcel is shipped
 * news with its tracking number, when it is shipped with one or when it is given one. A part split
 * from an order was placed once, as that order; an order merged into another was not cancelled for
 * its customer. Nothing for an erased customer's order.
 */
export class OrderNotifications {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    OrderEvents.OrderCancelled,
    OrderEvents.FulfillmentCreated,
    OrderEvents.FulfillmentUpdated,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case OrderEvents.OrderCreated: {
        const { splitFromId } = event.payload as Partial<OrderCreatedPayload>;
        if (!splitFromId) await this.#queue(event.shopId, 'order_placed', event.aggregateId);
        return;
      }
      case OrderEvents.OrderCancelled: {
        const { reason } = event.payload as Partial<OrderCancelledPayload>;
        if (reason !== 'merged') {
          await this.#queue(event.shopId, 'order_cancelled', event.aggregateId);
        }
        return;
      }
      case OrderEvents.FulfillmentCreated: {
        const { orderId, status } = event.payload as Partial<FulfillmentCreatedPayload>;
        if (orderId && status === 'in_transit') {
          await this.#queue(event.shopId, 'order_shipped', orderId, event.aggregateId);
        }
        return;
      }
      case OrderEvents.FulfillmentUpdated: {
        const { orderId, status, changed } = event.payload as Partial<FulfillmentUpdatedPayload>;
        if (orderId && status === 'delivered' && changed?.includes('status')) {
          await this.#queue(event.shopId, 'order_delivered', orderId, event.aggregateId);
        } else if (orderId && status === 'in_transit' && changed?.includes('tracking')) {
          await this.#queue(event.shopId, 'order_shipped', orderId, event.aggregateId);
        }
        return;
      }
    }
  }

  async #queue(
    shopId: string,
    kind: MessageKind,
    orderId: string,
    parcelId: string | null = null,
  ): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId, parcelId);
      if (!order || order.erased || !order.phone) return;
      // On its way with its tracking number; not news once it arrived.
      if (
        kind === 'order_shipped' &&
        (order.parcel?.status !== 'in_transit' || !order.parcel.number)
      ) {
        return;
      }
      const shop = await shopProfile(tx, shopId);
      await this.messages.queueIn(tx, shopId, {
        kind,
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        // A parcel's message is its own: an order may ship in parts.
        dedupeKey: `${kind}:${parcelId ?? orderId}`,
        variables: {
          name: order.name?.trim().split(/\s+/)[0] || undefined,
          shop: shop.name,
          order: `#${order.number}`,
          total: formatMoney(money(order.total, order.currency as CurrencyCode)),
          courier: order.parcel?.company ?? undefined,
          tracking: order.parcel?.number ?? undefined,
          url: order.parcel?.url ?? undefined,
        },
      });
    });
  }
}

/** How many of a shop's messages go in one round. */
const BATCH = 50;

/** How long a message taken to send waits before another sender may take it. */
const LEASE_MS = 5 * 60_000;

/** A message not sent within a day is too late to help. */
const GIVE_UP_MS = 24 * 60 * 60_000;

/** A WhatsApp message not delivered within this goes by SMS too (07 §1). */
export const SMS_AFTER_MS = 15 * 60_000;

/** When to try again after `attempts` tries: a minute after the first, doubling to an hour. */
export function messageRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 60 * 60_000);
}

export interface MessagesSenderOptions {
  messages: MessagesService;
  /** How each channel sends; a channel without one fails its messages, as not set up. */
  providers: Partial<Record<MessageChannel, MessageProvider>>;
  logger?: Logger;
}

/**
 * Sends the messages due (ADR-146), a shop at a time: each by its channel's provider, unless its
 * customer asked the shop to stop there. What a provider cannot take yet is tried again, a minute
 * on and doubling to an hour, for a day; what WhatsApp cannot deliver goes by SMS, as does what it
 * took and did not deliver within 15 minutes.
 */
export class MessagesSender {
  constructor(private readonly options: MessagesSenderOptions) {}

  /** One round: SMS for WhatsApp's undelivered, then every shop's messages due. How many went. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { messages, providers, logger } = this.options;
    if (providers.sms) await messages.replaceUndelivered(at, SMS_AFTER_MS, GIVE_UP_MS);
    let sent = 0;
    for (const shopId of await messages.dueShops(at)) {
      try {
        sent += await this.send(shopId, at);
      } catch (error) {
        // One shop's failure is not the others': its messages are due again after their lease.
        logger?.warn({ err: error, shopId }, 'messages not sent');
      }
    }
    return sent;
  }

  /** Sends the shop's messages due at `at`, a round's worth. How many went. */
  async send(shopId: string, at: Date): Promise<number> {
    const { messages } = this.options;
    const claimed = await messages.claim(shopId, at, BATCH, LEASE_MS);
    if (claimed.length === 0) return 0;
    const stopped = new Map<MessageChannel, Set<string>>();
    for (const channel of new Set(claimed.map((message) => message.channel))) {
      const recipients = claimed
        .filter((message) => message.channel === channel)
        .map((message) => message.recipient);
      stopped.set(channel, await messages.optedOut(shopId, channel, recipients));
    }
    // Those not tried by half the lease wait for it to end: past it, another sender may take them.
    const deadline = Date.now() + LEASE_MS / 2;
    let sent = 0;
    for (const message of claimed) {
      if (Date.now() > deadline) break;
      const outcome = await this.#attempt(message, stopped, at);
      // Recorded at once: WhatsApp's webhook tells of a message within seconds of its sending.
      await messages.settle(shopId, [outcome], at);
      if (outcome.status === 'sent') sent++;
    }
    return sent;
  }

  async #attempt(
    message: ClaimedMessage,
    stopped: ReadonlyMap<MessageChannel, ReadonlySet<string>>,
    at: Date,
  ): Promise<MessageOutcome> {
    const { providers } = this.options;
    const { id } = message;
    const replaceable = message.channel === 'whatsapp' && providers.sms !== undefined;
    if (stopped.get(message.channel)?.has(message.recipient)) {
      return { id, status: 'skipped', error: 'Not sent: the customer asked the shop to stop' };
    }
    if (at.getTime() - message.createdAt.getTime() > GIVE_UP_MS) {
      return { id, status: 'failed', error: 'Not sent within a day', replace: false };
    }
    const provider = providers[message.channel];
    if (!provider) {
      return {
        id,
        status: 'failed',
        error: `No ${message.channel === 'sms' ? 'SMS gateway' : 'WhatsApp number'} is set up`,
        replace: replaceable,
      };
    }
    const result = await provider.send(message);
    if (result.ok) {
      return {
        id,
        status: 'sent',
        provider: provider.name,
        providerMessageId: result.providerMessageId,
      };
    }
    return result.outcome === 'retry'
      ? {
          id,
          status: 'pending',
          error: result.error,
          nextAttemptAt: new Date(at.getTime() + messageRetryDelayMs(message.attempts)),
        }
      : {
          id,
          status: 'failed',
          error: result.error,
          replace: result.outcome === 'replace' && replaceable,
        };
  }

  /** Sends now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'messages sweep failed'),
    );
  }
}

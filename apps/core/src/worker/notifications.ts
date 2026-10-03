import { PublicSite, shopProfile } from '@hatti/api';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import {
  MessagesService,
  MessagingEvents,
  SECRET_KINDS,
  messageCostOf,
  paidByShop,
  settingsIn,
  type ClaimedMessage,
  type MessageCharges,
  type MessageChannel,
  type MessageKind,
  type MessageOutcome,
  type MessageProvider,
  type MessageRepliedPayload,
  type MessageVariables,
} from '@hatti/messaging/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import {
  CustomerAnswers,
  ORDER_LINK_PATH,
  OrderEvents,
  messageLinkIn,
  orderNotificationFactsIn,
  type FulfillmentCreatedPayload,
  type FulfillmentEventCreatedPayload,
  type FulfillmentUpdatedPayload,
  type OrderCancelledPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderPaymentRemindedPayload,
  type OrderNotificationFacts,
} from '@hatti/orders/public';
import { repeat } from './repeat.js';

/** How the timeline names what customers do through Hatti's messages. */
const ON_WHATSAPP = 'on WhatsApp';

/**
 * Queues what a shop's customers are told about their orders (MSG-01, ADR-146), once each: their
 * order placed, paid before it ships (ADR-171), each parcel shipped and delivered, and the order
 * cancelled. A parcel is shipped
 * news with its tracking number, when it is shipped with one or when it is given one, and its
 * order's page, where its way shows (ADR-160); each time it goes out for delivery with cash to
 * pay, what to keep ready for the rider. A part split from an order was placed once, as that
 * order; an order merged into another was not cancelled for its customer. Nothing for an erased
 * customer's order.
 *
 * A cash-on-delivery order waiting for its customer asks them to confirm it instead of saying it
 * was placed (COD-01, ADR-147), its link with it; their answer confirms or cancels it, or brings
 * them its page to change its address, and an order confirmed, by them or the shop, says so.
 */
export class OrderNotifications {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    OrderEvents.OrderConfirmed,
    OrderEvents.OrderCancelled,
    OrderEvents.OrderPaid,
    OrderEvents.OrderPaymentReminded,
    OrderEvents.OrderConfirmationReminded,
    OrderEvents.FulfillmentCreated,
    OrderEvents.FulfillmentUpdated,
    OrderEvents.FulfillmentEventCreated,
    MessagingEvents.MessageReplied,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    /** Where customers' order pages are, for the links messages carry. */
    private readonly site: PublicSite,
    private readonly answers: CustomerAnswers,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case OrderEvents.OrderCreated: {
        const { splitFromId } = event.payload as Partial<OrderCreatedPayload>;
        if (!splitFromId) await this.#placed(event.shopId, event.aggregateId);
        return;
      }
      case OrderEvents.OrderConfirmed:
        await this.#queue(event.shopId, 'order_confirmed', event.aggregateId);
        return;
      case OrderEvents.OrderCancelled: {
        const { reason } = event.payload as Partial<OrderCancelledPayload>;
        if (reason !== 'merged') {
          await this.#queue(event.shopId, 'order_cancelled', event.aggregateId);
        }
        return;
      }
      case OrderEvents.OrderPaid: {
        const { stage } = event.payload as Partial<OrderPaidPayload>;
        // News while the order waits to ship; cash paid at the door is none to whoever paid it.
        if (stage && PAID_AHEAD.includes(stage)) await this.#paid(event.shopId, event.aggregateId);
        return;
      }
      case OrderEvents.OrderConfirmationReminded:
        await this.#askAgain(event.shopId, event.aggregateId);
        return;
      case OrderEvents.OrderPaymentReminded: {
        const { cancelAt } = event.payload as Partial<OrderPaymentRemindedPayload>;
        if (cancelAt) await this.#remind(event.shopId, event.aggregateId, new Date(cancelAt));
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
      case OrderEvents.FulfillmentEventCreated: {
        const { orderId, fulfillmentId, status } =
          event.payload as Partial<FulfillmentEventCreatedPayload>;
        if (orderId && fulfillmentId && status === 'out_for_delivery') {
          await this.#outForDelivery(event.shopId, orderId, fulfillmentId, event.aggregateId);
        }
        return;
      }
      case MessagingEvents.MessageReplied:
        await this.#answered(event);
        return;
    }
  }

  /**
   * The shop has the customer's payment before the order ships (ADR-171): told once the order is
   * paid in full, or, paying on delivery, once its advance is in, with what is left for the
   * rider. Nothing for a part paid otherwise, or a cancelled order.
   */
  async #paid(shopId: string, orderId: string): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || order.cancelReason) return;
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      const variables = {
        ...(await this.#variables(tx, shopId, order)),
        amount: rupees(order.amountPaid),
      };
      const base = { recipient: order.phone, orderId, customerId: order.customerId };
      if (order.amountPaid >= order.total) {
        await this.messages.queueIn(tx, shopId, {
          ...base,
          kind: 'order_paid',
          dedupeKey: `order_paid:${orderId}`,
          variables,
        });
      } else if (order.cashDue > 0n && order.amountPaid >= order.advanceDue) {
        await this.messages.queueIn(tx, shopId, {
          ...base,
          kind: 'order_advance_paid',
          // Once for each sum received.
          dedupeKey: `order_advance_paid:${orderId}:${order.amountPaid}`,
          variables: { ...variables, due: rupees(order.cashDue) },
        });
      }
    });
  }

  /**
   * A cash-on-delivery order still waiting for its customer's answer asks them once more (ADR-175),
   * with the same buttons, and the link its messages carry. Nothing for one answered meanwhile, or
   * where the shop asks no one.
   */
  async #askAgain(shopId: string, orderId: string): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || !order.awaitsCustomer) return;
      if ((await settingsIn(tx, shopId)).disabled.includes('order_confirmation')) return;
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'order_confirmation_reminder',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_confirmation_reminder:${orderId}`,
        variables: await this.#variables(tx, shopId, order),
      });
      if (id) await this.#carryPage(tx, shopId, orderId, id, 'asking them again to confirm it');
    });
  }

  /**
   * An order still waiting for its payment is cancelled at `cancelAt` (ADR-174): its customer is
   * told what it waits for and by when, in the shop's time, with its page, which says how to pay.
   * Nothing for one paid or cancelled meanwhile.
   */
  async #remind(shopId: string, orderId: string, cancelAt: Date): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || order.cancelReason || order.awaited <= 0n) {
        return;
      }
      const { timezone } = await shopProfile(tx, shopId);
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'order_payment_reminder',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_payment_reminder:${orderId}`,
        variables: {
          ...(await this.#variables(tx, shopId, order)),
          amount: formatMoney(money(order.awaited, order.currency as CurrencyCode)),
          date: shopTime(timezone, cancelAt),
        },
      });
      if (id) await this.#carryPage(tx, shopId, orderId, id, 'reminding them to pay');
    });
  }

  /**
   * A parcel with cash to pay went out for delivery (ADR-160): what to keep ready for the rider,
   * with the order's page, each time it goes out. Not news once it arrived, or came back.
   */
  async #outForDelivery(
    shopId: string,
    orderId: string,
    parcelId: string,
    stepId: string,
  ): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId, parcelId);
      if (!order || order.erased || !order.phone || order.cashDue <= 0n) return;
      if (order.parcel?.status !== 'in_transit') return;
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'order_out_for_delivery',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_out_for_delivery:${stepId}`,
        variables: {
          ...(await this.#variables(tx, shopId, order)),
          due: formatMoney(money(order.cashDue, order.currency as CurrencyCode)),
        },
      });
      if (id) await this.#carryPage(tx, shopId, orderId, id, 'that it is out for delivery');
    });
  }

  /**
   * The order's page for the message `messageId` to carry (ADR-160): the link its messages carry
   * while it works, else a new one, said on the timeline to have gone with the message `about`.
   */
  async #carryPage(
    tx: Tx,
    shopId: string,
    orderId: string,
    messageId: string,
    about: string,
  ): Promise<void> {
    const pages = this.site.url(`/${ORDER_LINK_PATH}/`);
    const known = (await this.messages.linksIn(tx, shopId, orderId))
      .filter((url) => url.startsWith(pages))
      .map((url) => url.slice(pages.length));
    const path = await messageLinkIn(tx, shopId, orderId, `with the message ${about}`, known);
    if (path) await this.messages.linkIn(tx, shopId, messageId, this.site.url(path));
  }

  /**
   * An order placed: asked to confirm it, with its link, while it waits for its customer and the
   * shop has not turned that off; told it was placed otherwise.
   */
  async #placed(shopId: string, orderId: string): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone) return;
      const variables = await this.#variables(tx, shopId, order);
      const asking =
        order.awaitsCustomer &&
        !(await settingsIn(tx, shopId)).disabled.includes('order_confirmation');
      const kind: MessageKind = asking ? 'order_confirmation' : 'order_placed';
      const id = await this.messages.queueIn(tx, shopId, {
        kind,
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `${kind}:${orderId}`,
        variables,
      });
      // Its link is made once it is queued: an event heard twice makes one, and the link the
      // message carries stays the order's.
      if (!id || !asking) return;
      const path = await messageLinkIn(
        tx,
        shopId,
        orderId,
        'with the message asking them to confirm the order',
      );
      if (path) await this.messages.linkIn(tx, shopId, id, this.site.url(path));
    });
  }

  /** A customer pressed a button of a message asking them to confirm their order. */
  async #answered(event: DomainEvent): Promise<void> {
    const { kind, orderId, answer } = event.payload as Partial<MessageRepliedPayload>;
    // Asked first, or again (ADR-175): the same answers.
    if ((kind !== 'order_confirmation' && kind !== 'order_confirmation_reminder') || !orderId) {
      return;
    }
    const { shopId } = event;
    if (answer === 'confirm' || answer === 'cancel') {
      await this.answers.answer(shopId, orderId, answer, ON_WHATSAPP);
      return;
    }
    if (answer !== 'address') return;
    // The order's page, where they change it: the link the message asking them came with.
    const queued = await this.database.tenant(shopId, async (tx) => {
      const asked = await this.messages.messageIn(tx, shopId, event.aggregateId);
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!asked?.variables.url || !order || order.erased || !order.phone) return false;
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'order_address',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_address:${event.aggregateId}`,
        variables: { ...(await this.#variables(tx, shopId, order)), url: asked.variables.url },
      });
      return id !== null;
    });
    if (queued) await this.answers.note(shopId, orderId, 'to change the address', ON_WHATSAPP);
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
      const id = await this.messages.queueIn(tx, shopId, {
        kind,
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        // A parcel's message is its own: an order may ship in parts.
        dedupeKey: `${kind}:${parcelId ?? orderId}`,
        variables: await this.#variables(tx, shopId, order),
      });
      // Its page, where the parcel's way shows (ADR-160).
      if (id && kind === 'order_shipped') {
        await this.#carryPage(tx, shopId, orderId, id, 'that it was shipped');
      }
    });
  }

  async #variables(
    tx: Tx,
    shopId: string,
    order: OrderNotificationFacts,
  ): Promise<MessageVariables> {
    const shop = await shopProfile(tx, shopId);
    return {
      name: order.name?.trim().split(/\s+/)[0] || undefined,
      shop: shop.name,
      order: `#${order.number}`,
      total: formatMoney(money(order.total, order.currency as CurrencyCode)),
      courier: order.parcel?.company ?? undefined,
      tracking: order.parcel?.number ?? undefined,
    };
  }
}

/** `at` as the shop's customers read it, in its time zone: "4 Oct, 3:00 pm". */
export function shopTime(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/** An order's stages before it ships, when a payment is news to its customer (ADR-171). */
const PAID_AHEAD: readonly string[] = [
  'needs_confirmation',
  'needs_review',
  'awaiting_payment',
  'to_pack',
  'to_book',
];

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
  /**
   * What each shop's messages are paid from (ADR-155): a message its credit cannot pay for waits.
   * Without it, messages go unpaid for.
   */
  charges?: MessageCharges;
  logger?: Logger;
}

/** Why a message waits, or a code was not sent: the shop's credit cannot pay for it. */
const NO_CREDIT = {
  waiting: "Waiting for the shop's message credit",
  failed: "Not sent: the shop's message credit ran out",
};

/**
 * Sends the messages due (ADR-146), a shop at a time: each by its channel's provider, unless its
 * customer asked the shop to stop there. What a provider cannot take yet is tried again, a minute
 * on and doubling to an hour, for a day; what WhatsApp cannot deliver goes by SMS, as does what it
 * took and did not deliver within 15 minutes. Each is paid for from the shop's credit as it goes
 * (ADR-155): what the credit cannot pay for waits as long, but a code, which works for minutes, is
 * not sent at all. Hatti's own notices to the shop about its bills cost it nothing (ADR-169).
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
    // What the shop's credit has left to pay for, as the round spends it.
    const { charges } = this.options;
    let credit = charges ? await charges.balanceOf(shopId) : null;
    // Those not tried by half the lease wait for it to end: past it, another sender may take them.
    const deadline = Date.now() + LEASE_MS / 2;
    let sent = 0;
    for (const message of claimed) {
      if (Date.now() > deadline) break;
      // Hatti's own notices to the shop are Hatti's to pay for, whatever its credit (ADR-169).
      const paid = charges !== undefined && paidByShop(message.kind);
      const price = paid ? charges.priceOf(messageCostOf(message)) : 0n;
      const outcome = await this.#attempt(
        message,
        stopped,
        at,
        !paid || credit === null || credit >= price,
      );
      // Recorded at once: WhatsApp's webhook tells of a message within seconds of its sending.
      await messages.settle(shopId, [outcome], at);
      if (outcome.status === 'sent') {
        sent++;
        if (credit !== null) credit -= price;
      }
    }
    return sent;
  }

  async #attempt(
    message: ClaimedMessage,
    stopped: ReadonlyMap<MessageChannel, ReadonlySet<string>>,
    at: Date,
    paidFor: boolean,
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
    if (!paidFor) {
      return SECRET_KINDS.includes(message.kind)
        ? { id, status: 'failed', error: NO_CREDIT.failed, replace: false }
        : {
            id,
            status: 'pending',
            error: NO_CREDIT.waiting,
            nextAttemptAt: new Date(at.getTime() + messageRetryDelayMs(message.attempts)),
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

import { PublicSite, shopProfile } from '@hatti/api';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { shopLogoOf } from '@hatti/files/public';
import type { Logger } from '@hatti/logger';
import {
  LIBRARY_KINDS,
  MessagesService,
  MARKETING_KINDS,
  MessagingEvents,
  SECRET_KINDS,
  TO_THE_SHOP_KINDS,
  WHATSAPP_ONLY_KINDS,
  chargedFor,
  libraryKey,
  messageCostOf,
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
import { shopAccentOf } from '@hatti/online-store/public';
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
  type OrderUpdatedPayload,
  type OrderNotificationFacts,
} from '@hatti/orders/public';
import { LOGOS_PATH } from '../api/logos.js';
import type { OwnNumber } from '../messaging.js';
import { repeat } from './repeat.js';

/** How the timeline names what customers do through Hatti's messages. */
const ON_WHATSAPP = 'on WhatsApp';
const ON_A_CALL = 'on an automated call';

/**
 * Queues what a shop's customers are told about their orders (MSG-01, ADR-146), once each: their
 * order placed, paid before it ships (ADR-171), each parcel shipped and delivered, and the order
 * cancelled. A parcel is shipped
 * news with its tracking number, when it is shipped with one or when it is given one, and its
 * order's page, where its way shows (ADR-160); each time it goes out for delivery with cash to
 * pay, what to keep ready for the rider. A part split from an order was placed once, as that
 * order; an order merged into another was not cancelled for its customer. Nothing for an erased
 * customer's order. Each goes to the email the customer gave with the order too (ADR-181).
 *
 * A cash-on-delivery order waiting for its customer asks them to confirm it instead of saying it
 * was placed (COD-01, ADR-147), its link with it; their answer confirms or cancels it, or brings
 * them its page to change its address, and an order confirmed, by them or the shop, says so. A
 * delivery that failed asks whether to deliver it again or call them first (COD-08, ADR-388), and
 * their answer is kept for the shop. One whose customer left the reminder unanswered is called,
 * where the shop says to, the key they press its answer (COD-03, ADR-611). An order its customer collects says where once it is ready
 * (ADR-389).
 *
 * An order placed and paid together hears of its payment alone (ADR-621): the news of it paid in
 * full takes the place of the news of it placed while no sender has taken that yet, and one placed
 * to be paid online at checkout waits {@link PLACED_WAITS_MS} for it.
 */
export class OrderNotifications {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    OrderEvents.OrderConfirmed,
    OrderEvents.OrderUpdated,
    OrderEvents.OrderCancelled,
    OrderEvents.OrderPaid,
    OrderEvents.OrderPaymentReminded,
    OrderEvents.OrderConfirmationReminded,
    OrderEvents.OrderConfirmationCalled,
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
      case OrderEvents.OrderUpdated: {
        const { changed, stage } = event.payload as Partial<OrderUpdatedPayload>;
        if (changed?.includes('packed') && stage === 'ready_for_pickup') {
          await this.#readyForPickup(event.shopId, event.aggregateId);
        }
        return;
      }
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
      case OrderEvents.OrderConfirmationCalled:
        await this.#call(event.shopId, event.aggregateId);
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
        } else if (orderId && fulfillmentId && status === 'attempted_delivery') {
          await this.#deliveryFailed(event.shopId, orderId, fulfillmentId, event.aggregateId);
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
   * rider; part of what it waits for, by transfer or as staff recorded it, with what is left to
   * pay and its page (ADR-629). Nothing for a cancelled order.
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
      const base = {
        recipient: order.phone,
        email: order.email,
        orderId,
        customerId: order.customerId,
      };
      if (order.amountPaid >= order.total) {
        // Paid while the news of it placed waits (ADR-621): this says both, in its place.
        await this.messages.supersedeIn(
          tx,
          shopId,
          `order_placed:${orderId}`,
          'Not sent: the message of its payment said it was placed',
        );
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
      } else if (order.awaited > 0n && order.amountPaid > 0n) {
        const id = await this.messages.queueIn(tx, shopId, {
          ...base,
          kind: 'order_part_paid',
          // Once for each sum received, as the advance's.
          dedupeKey: `order_part_paid:${orderId}:${order.amountPaid}`,
          variables: { ...variables, left: rupees(order.awaited) },
        });
        if (id) await this.#carryPage(tx, shopId, orderId, id, 'that part of its payment came');
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
        email: order.email,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_confirmation_reminder:${orderId}`,
        variables: await this.#variables(tx, shopId, order),
      });
      if (id) await this.#carryPage(tx, shopId, orderId, id, 'asking them again to confirm it');
    });
  }

  /**
   * A cash-on-delivery order whose customer left the reminder unanswered is called (ADR-611): an
   * automated call in Urdu, whatever the shop's language, which customers who read no English, or
   * no WhatsApp, understand. Nothing for one answered meanwhile.
   */
  async #call(shopId: string, orderId: string): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || !order.awaitsCustomer) return;
      const shop = await shopProfile(tx, shopId);
      await this.messages.queueIn(tx, shopId, {
        kind: 'order_confirmation_call',
        channel: 'voice',
        language: 'ur',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_confirmation_call:${orderId}`,
        variables: {
          shop: shop.name,
          order: `#${order.number}`,
          total: formatMoney(money(order.total, order.currency as CurrencyCode)),
        },
      });
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
        email: order.email,
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
        email: order.email,
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
   * An order its customer collects is packed and waits for them (SHP-15, ADR-389): where to come,
   * and what the location tells customers of picking up there. Once; not once it was picked up.
   */
  async #readyForPickup(shopId: string, orderId: string): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || !order.pickup) return;
      if (order.stage !== 'ready_for_pickup') return;
      const { name, address, instructions } = order.pickup;
      await this.messages.queueIn(tx, shopId, {
        kind: 'order_ready_for_pickup',
        recipient: order.phone,
        email: order.email,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_ready_for_pickup:${orderId}`,
        variables: {
          ...(await this.#variables(tx, shopId, order)),
          location: name,
          address: instructions ? `${address || name} (${instructions})` : address || name,
        },
      });
    });
  }

  /**
   * The courier tried to deliver a parcel and could not (COD-08, ADR-388): its customer asked,
   * each time, whether to deliver it again or call them first, their answer for the shop to tell
   * the courier. Not once it arrived, or is coming back.
   */
  async #deliveryFailed(
    shopId: string,
    orderId: string,
    parcelId: string,
    stepId: string,
  ): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderNotificationFactsIn(tx, shopId, orderId, parcelId);
      if (!order || order.erased || !order.phone) return;
      if (order.parcel?.status !== 'in_transit') return;
      const variables = await this.#variables(tx, shopId, order);
      await this.messages.queueIn(tx, shopId, {
        kind: 'order_delivery_failed',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `order_delivery_failed:${stepId}`,
        variables: { ...variables, courier: variables.courier ?? 'The courier' },
      });
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
        email: order.email,
        orderId,
        customerId: order.customerId,
        dedupeKey: `${kind}:${orderId}`,
        variables,
        // Paid online at checkout a moment later, as most are, the payment's news says both
        // (ADR-621): this waits to be taken over, and goes for an order left unpaid.
        notBefore:
          order.paymentMethod === 'online' && order.stage === 'awaiting_payment'
            ? new Date(Date.now() + PLACED_WAITS_MS)
            : null,
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

  /**
   * A customer pressed a button of a message asking them to confirm their order, or of one telling
   * them a delivery failed (ADR-388).
   */
  async #answered(event: DomainEvent): Promise<void> {
    const { kind, orderId, answer, at } = event.payload as Partial<MessageRepliedPayload>;
    if (kind === 'order_delivery_failed' && orderId) {
      if (answer === 'retry' || answer === 'call') {
        await this.answers.rescue(event.shopId, orderId, answer, ON_WHATSAPP, answeredAt(at));
      }
      return;
    }
    // Pressed on a call (ADR-611): 1 confirms it, 2 cancels it.
    if (kind === 'order_confirmation_call' && orderId) {
      if (answer === 'confirm' || answer === 'cancel') {
        await this.answers.answer(event.shopId, orderId, answer, ON_A_CALL);
      }
      return;
    }
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
        email: order.email,
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
      // Its email is laid out as the shop's own (ADR-198).
      ...(order.email ? await this.#look(tx, shopId, order) : {}),
    };
  }

  /**
   * What an email of the order's news shows of its shop and of it (ADR-198): the shop's accent
   * colour and its logo, as its customers' pages show them, the logo at the API's own address for
   * it, which lasts as an email does; the order's first lines, with how many more it has; and the
   * day checkout said to expect it by, while it is still to come (ADR-599).
   */
  async #look(
    tx: Tx,
    shopId: string,
    order: OrderNotificationFacts,
  ): Promise<Pick<MessageVariables, 'accent' | 'logo' | 'items' | 'more' | 'expected'>> {
    const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
    const items = order.lines
      .map((line) => `${lineName(line)} × ${line.quantity}\t${rupees(line.total)}`)
      .join('\n');
    const more = order.lineCount - order.lines.length;
    return {
      accent: (await shopAccentOf(tx, shopId)) ?? undefined,
      logo: (await shopLogoOf(tx, shopId)) ? this.site.url(`/${LOGOS_PATH}/${shopId}`) : undefined,
      items: items || undefined,
      more: more > 0 ? String(more) : undefined,
      expected: order.deliveryExpectedOn ?? undefined,
    };
  }
}

/** A line's name as an email lists it: its product's, and its variant's but the default's. */
function lineName(line: { title: string; variantTitle: string }): string {
  const variant = line.variantTitle.trim();
  const name = variant && variant !== 'Default Title' ? `${line.title}, ${variant}` : line.title;
  const flat = name.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
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

/** When a customer answered, as WhatsApp said: now, for a time it gave that is not one. */
function answeredAt(at: string | undefined): Date {
  const when = at ? new Date(at) : new Date();
  return Number.isNaN(when.getTime()) ? new Date() : when;
}

/** An order's stages before it ships, when a payment is news to its customer (ADR-171). */
const PAID_AHEAD: readonly string[] = [
  'needs_confirmation',
  'needs_review',
  'awaiting_payment',
  'to_pack',
  'to_book',
];

/**
 * How long the news of an order placed to be paid online at checkout waits for its payment,
 * whose news says both (ADR-621).
 */
export const PLACED_WAITS_MS = 10 * 60_000;

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

/** Whether a shop's broadcasts may go this round, and the number they go from (ADR-422). */
interface Marketing {
  open: boolean;
  nextOpen: Date;
  provider: MessageProvider | null;
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
  /**
   * Each shop's own WhatsApp number (ADR-419), which its broadcasts go from (ADR-422): none for a
   * shop that has not connected one. Without it, broadcasts fail, as not set up.
   */
  shopNumbers?: (shopId: string) => Promise<MessageProvider | null>;
  /**
   * The name each shop's customers' SMS go from, once Hatti approves one (ADR-469): null for
   * Hatti's shared sender. Without it, every SMS goes from the shared sender.
   */
  smsSenders?: (shopId: string) => Promise<string | null>;
  /**
   * Each shop's own number for its customers' order news (ADR-537), with Hatti's order templates
   * Meta approved on its account: a message whose template is approved there goes from it, the
   * rest from Hatti's number. Without it, all go from Hatti's.
   */
  ownNumbers?: (shopId: string) => Promise<OwnNumber | null>;
  logger?: Logger;
}

/** A message the sender took, with the name its SMS goes from where the shop has its own. */
type Outgoing = ClaimedMessage & { sender?: string | null };

/** Whether `message` goes from the shop's own SMS sender: an SMS to its customers (ADR-469). */
const fromShopSender = (message: ClaimedMessage): boolean =>
  message.channel === 'sms' && !TO_THE_SHOP_KINDS.includes(message.kind);

/** Whether `message` may go from the shop's own number: order news on WhatsApp (ADR-537). */
const fromOwnNumber = (message: ClaimedMessage): boolean =>
  message.channel === 'whatsapp' && LIBRARY_KINDS.includes(message.kind);

/** Why a broadcast failed: the shop's own number is not there to send it. */
const NO_SHOP_NUMBER = "The shop's own WhatsApp number is not connected";

/** Why a broadcast's message waits: marketing reaches customers by day alone (07 §1). */
const OUTSIDE_MARKETING_HOURS = 'Waiting for marketing hours';

/** Why a message failed with no provider for its channel. */
const NOT_SET_UP: Record<MessageChannel, string> = {
  whatsapp: 'No WhatsApp number is set up',
  sms: 'No SMS gateway is set up',
  email: 'No email service is set up',
  voice: 'No voice gateway is set up',
};

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
 * not sent at all. Hatti's own notices to the shop about its bills cost it nothing (ADR-169), nor
 * do its customers' emails (ADR-181). A broadcast's messages go from the shop's own number, in
 * marketing hours alone, and never by SMS (ADR-422); an SMS campaign's by SMS, in those hours
 * too, and never by WhatsApp (ADR-458). A shop's SMS to its customers go from its own sender name
 * once Hatti approves one (ADR-469). A shop's customers' order news goes from the shop's own
 * number where Meta approved Hatti's template for it on the shop's account (ADR-537).
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
    const marketing = await this.#marketing(shopId, claimed, at);
    const { smsSenders } = this.options;
    const sender = smsSenders && claimed.some(fromShopSender) ? await smsSenders(shopId) : null;
    const { ownNumbers } = this.options;
    const own = ownNumbers && claimed.some(fromOwnNumber) ? await ownNumbers(shopId) : null;
    // What the shop's credit has left to pay for, as the round spends it.
    const { charges } = this.options;
    let credit = charges ? await charges.balanceOf(shopId) : null;
    // Those not tried by half the lease wait for it to end: past it, another sender may take them.
    const deadline = Date.now() + LEASE_MS / 2;
    let sent = 0;
    for (const claimedMessage of claimed) {
      if (Date.now() > deadline) break;
      const message: Outgoing =
        sender && fromShopSender(claimedMessage) ? { ...claimedMessage, sender } : claimedMessage;
      // Hatti's own notices to the shop are Hatti's to pay for, whatever its credit (ADR-169), as
      // are emails (ADR-181).
      const paid = charges !== undefined && chargedFor(message);
      const price = paid ? charges.priceOf(messageCostOf(message)) : 0n;
      const outcome = MARKETING_KINDS.includes(message.kind)
        ? await this.#marketingAttempt(message, marketing, stopped, at, credit, price)
        : await this.#attempt(
            message,
            own &&
              fromOwnNumber(message) &&
              own.approved.has(libraryKey(message.kind, message.language))
              ? own.provider
              : this.options.providers[message.channel],
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

  /**
   * What a round with broadcasts needs for them (ADR-422): whether marketing may go now in the
   * shop's time, and the shop's own number for those on WhatsApp. Nothing asked for a round
   * without one.
   */
  async #marketing(
    shopId: string,
    claimed: readonly ClaimedMessage[],
    at: Date,
  ): Promise<Marketing | null> {
    if (!claimed.some((message) => MARKETING_KINDS.includes(message.kind))) return null;
    const { messages, shopNumbers } = this.options;
    const hours = await messages.marketingHoursOf(shopId, at);
    const own = claimed.some((message) => WHATSAPP_ONLY_KINDS.includes(message.kind));
    return {
      ...hours,
      provider: hours.open && own && shopNumbers ? await shopNumbers(shopId) : null,
    };
  }

  /**
   * A broadcast's message (ADR-422): it waits for marketing hours, goes from the shop's own number
   * or fails, and never goes by SMS; an SMS campaign's goes by Hatti's SMS gateway (ADR-458).
   * Nothing goes in their place. Each is paid for, as any marketing message is.
   */
  async #marketingAttempt(
    message: Outgoing,
    marketing: Marketing | null,
    stopped: ReadonlyMap<MessageChannel, ReadonlySet<string>>,
    at: Date,
    credit: bigint | null,
    price: bigint,
  ): Promise<MessageOutcome> {
    if (marketing && !marketing.open && !stopped.get(message.channel)?.has(message.recipient)) {
      return {
        id: message.id,
        status: 'pending',
        error: OUTSIDE_MARKETING_HOURS,
        nextAttemptAt: marketing.nextOpen,
      };
    }
    const own = WHATSAPP_ONLY_KINDS.includes(message.kind);
    const outcome = await this.#attempt(
      message,
      own ? (marketing?.provider ?? undefined) : this.options.providers[message.channel],
      stopped,
      at,
      credit === null || credit >= price,
      own ? NO_SHOP_NUMBER : NOT_SET_UP[message.channel],
    );
    return outcome.status === 'failed' ? { ...outcome, replace: false } : outcome;
  }

  async #attempt(
    message: Outgoing,
    provider: MessageProvider | undefined,
    stopped: ReadonlyMap<MessageChannel, ReadonlySet<string>>,
    at: Date,
    paidFor: boolean,
    notSetUp: string = NOT_SET_UP[message.channel],
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
    if (!provider) {
      return { id, status: 'failed', error: notSetUp, replace: replaceable };
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

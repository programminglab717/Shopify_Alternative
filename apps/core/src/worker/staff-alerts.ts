import { scopeWithin, shopProfile } from '@hatti/api';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { staffPhonesIn } from '@hatti/identity/public';
import { toPublicId } from '@hatti/ids';
import type {
  MessageKind,
  MessagesService,
  PushMessage,
  PushRecipient,
  PushService,
} from '@hatti/messaging/public';
import type { StaffRole } from '@hatti/api';
import {
  OrderEvents,
  mentionsIn,
  orderName,
  ordersToShipOfCustomerIn,
  staffAlertFactsIn,
  type FulfillmentUpdatedPayload,
  type OrderAssignedPayload,
  type OrderCommentPayload,
  type OrderUpdatedPayload,
  type RefusedOrders,
} from '@hatti/orders/public';

/**
 * What an event tells staff of: an order given to one of them, a comment that may name some, a
 * receipt its customer sent for its transfer, or a parcel its customer refused.
 */
type Alert =
  | {
      kind: 'order_assigned';
      orderId: string;
      assigneeId: string;
      /** Given with others at once (ADR-634): told once for them all. */
      batch: { id: string; size: number } | null;
    }
  | { kind: 'order_mentioned'; orderId: string; commentId: string }
  | { kind: 'order_receipt_sent'; orderId: string }
  | { kind: 'customer_refused'; orderId: string; fulfillmentId: string };

/**
 * Who looks for a transfer's money in the shop's bank when no one has its order (ADR-247): owners
 * and managers who may mark the order paid, a custom role's member only if it holds `write_orders`
 * (ADR-581).
 */
const PAYMENT_ROLES: readonly StaffRole[] = ['owner', 'manager'];

/**
 * Who calls a customer before their next order ships when no one has it (ADR-673): as its push
 * (ADR-672), owners, managers and confirmation agents who may change orders.
 */
const CALLING_ROLES: readonly StaffRole[] = ['owner', 'manager', 'confirmation_agent'];

/**
 * Tells members of staff on WhatsApp of their own work (ORD-10, ORD-02, ADR-191), at the number
 * their account signs in with, which identity gives for the shop alone (ADR-193), as the orders'
 * events are heard: an order someone else gave them,
 * unless it was given to another since; and a comment that names them as `@` and their name, but
 * not its author, once a comment however often it is changed. And a receipt a customer sent for
 * an order that still waits for its transfer (ADR-247): told to whom the order is given, else to
 * the owners and managers who may mark it paid (ADR-581), once a receipt. Nothing for those who
 * left the shop or proved no number, nor what the shop turned off; each is the shop's message,
 * paid from its credit as its other alerts are. An order given to a member, and a comment naming
 * them, are pushed to their browsers too (ADR-633), number or none, once each, in their language,
 * opening the order, saying neither its customer nor the comment's words. And a parcel its
 * customer refused (ADR-673), of each other order of theirs confirmed and not yet shipped: told to
 * whom that order is given, else to the owners, managers and confirmation agents who may change
 * orders, once a parcel and order, to call them before it ships; pushed apart (ADR-672).
 */
export class StaffAlerts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderAssigned,
    OrderEvents.OrderCommentCreated,
    OrderEvents.OrderCommentUpdated,
    OrderEvents.OrderUpdated,
    OrderEvents.FulfillmentUpdated,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly push: PushService | null = null,
    /** The orders to call before they ship, their customer having refused `orderId`'s parcel. */
    private readonly toShip: (
      tx: Tx,
      shopId: string,
      orderId: string,
    ) => Promise<RefusedOrders | null> = ordersToShipOfCustomerIn,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const alert = alertOf(event);
    if (!alert) return;
    const { shopId } = event;
    const pushes = await this.database.tenant(shopId, async (tx): Promise<StaffPush[]> => {
      // Through identity's function for the shop of the transaction, never its tables (ADR-193).
      const staff = await staffPhonesIn(tx, shopId);
      if (alert.kind === 'customer_refused') {
        await this.#refused(tx, event, alert, staff);
        // Pushed by the shop's push notices already (ADR-672).
        return [];
      }
      const facts = await staffAlertFactsIn(
        tx,
        shopId,
        alert.orderId,
        alert.kind === 'order_mentioned' ? alert.commentId : null,
      );
      if (!facts) return [];
      let told: string[];
      if (alert.kind === 'order_assigned') {
        // Given to another since, who is told instead.
        if (facts.assigneeId !== alert.assigneeId) return [];
        told = [alert.assigneeId];
      } else if (alert.kind === 'order_receipt_sent') {
        // Marked paid, or cancelled, since: nothing left to look for.
        if (!facts.awaitingTransfer) return [];
        const assignee = staff.find((member) => member.userId === facts.assigneeId);
        told = assignee
          ? [assignee.userId]
          : staff
              .filter(
                (member) =>
                  PAYMENT_ROLES.includes(member.role) && scopeWithin('write_orders', member.scopes),
              )
              .map((member) => member.userId);
      } else {
        const comment = facts.comment;
        if (!comment) return [];
        told = mentionsIn(comment.message, staff).filter((userId) => userId !== comment.authorId);
      }
      if (told.length === 0) return [];
      // Many given at once say the first handled and how many more: "#1043 (+24)".
      const batch = alert.kind === 'order_assigned' ? alert.batch : null;
      const variables = {
        shop: (await shopProfile(tx, shopId)).name,
        order: orderName(facts.number) + (batch ? ` (+${batch.size - 1})` : ''),
      };
      for (const userId of told) {
        const member = staff.find((each) => each.userId === userId);
        if (!member?.phone) continue;
        await this.messages.queueIn(tx, shopId, {
          kind: alert.kind satisfies MessageKind,
          recipient: member.phone,
          // In their own language, which may not be the shop's (ADR-194).
          language: member.language,
          // Each assignment once, and many given at once once for them all; each comment once for
          // each member it names, edited or not; each receipt once for each member told.
          dedupeKey:
            alert.kind === 'order_assigned'
              ? batch
                ? `order_assigned:batch:${batch.id}`
                : `order_assigned:${event.id}`
              : alert.kind === 'order_receipt_sent'
                ? `order_receipt_sent:${event.id}:${userId}`
                : `order_mentioned:${alert.commentId}:${userId}`,
          variables,
          channel: 'whatsapp',
        });
      }
      if (alert.kind === 'order_receipt_sent') return [];
      // Pushed whether or not they proved a number: their browser is theirs.
      const orders = `/${toPublicId('shop', shopId)}/orders`;
      const url = batch
        ? `${orders}?q=${encodeURIComponent('assignee:me')}`
        : `${orders}/${toPublicId('order', alert.orderId)}`;
      return told.flatMap((userId): StaffPush[] => {
        const member = staff.find((each) => each.userId === userId);
        if (!member) return [];
        return [
          {
            kind: alert.kind,
            dedupeKey:
              alert.kind === 'order_assigned'
                ? batch
                  ? `push:order_assigned:batch:${batch.id}`
                  : `push:order_assigned:${event.id}`
                : `push:order_mentioned:${alert.commentId}:${userId}`,
            recipient: {
              userId,
              role: member.role,
              language: member.language,
              scopes: member.scopes,
              capabilities: member.capabilities,
            },
            message: batch
              ? manyGivenMessage(variables.shop, batch.size, url)
              : staffPushMessage(alert.kind, variables.shop, variables.order, url),
          },
        ];
      });
    });
    // After the transaction: a push service may be slow, and the messages are kept already.
    const push = this.push;
    if (!push) return;
    for (const each of pushes) {
      await push.push(shopId, each.kind, each.dedupeKey, [each.recipient], each.message);
    }
  }

  /** Each order of the customer's still to ship, to whom it is given, else those who call. */
  async #refused(
    tx: Tx,
    event: DomainEvent,
    alert: Extract<Alert, { kind: 'customer_refused' }>,
    staff: Awaited<ReturnType<typeof staffPhonesIn>>,
  ): Promise<void> {
    const { shopId } = event;
    const orders = await this.toShip(tx, shopId, alert.orderId);
    if (!orders || orders.toShip.length === 0) return;
    const shop = (await shopProfile(tx, shopId)).name;
    const callers = staff
      .filter(
        (member) =>
          CALLING_ROLES.includes(member.role) && scopeWithin('write_orders', member.scopes),
      )
      .map((member) => member.userId);
    for (const order of orders.toShip) {
      const facts = await staffAlertFactsIn(tx, shopId, order.id, null);
      if (!facts) continue;
      const assignee = staff.find((member) => member.userId === facts.assigneeId);
      const told = assignee ? [assignee.userId] : callers;
      for (const userId of told) {
        const member = staff.find((each) => each.userId === userId);
        if (!member?.phone) continue;
        await this.messages.queueIn(tx, shopId, {
          kind: alert.kind satisfies MessageKind,
          recipient: member.phone,
          language: member.language,
          // Once a parcel and order for each member told, however often the parcel is heard of.
          dedupeKey: `customer_refused:${alert.fulfillmentId}:${order.id}:${userId}`,
          variables: {
            shop,
            order: orderName(order.number),
            refused: orderName(orders.refused.number),
          },
          channel: 'whatsapp',
        });
      }
    }
  }
}

/** A push to one member of their own work (ADR-633). */
interface StaffPush {
  kind: 'order_assigned' | 'order_mentioned';
  dedupeKey: string;
  recipient: PushRecipient;
  message: PushMessage;
}

/** "Zari: order #1043 is yours", in English and Urdu, opening the order. */
function staffPushMessage(
  kind: StaffPush['kind'],
  shop: string,
  order: string,
  url: string,
): PushMessage {
  return kind === 'order_assigned'
    ? {
        en: { title: `${shop}: order ${order} is yours`, body: 'It was given to you to work on.' },
        ur: { title: `${shop}: آرڈر ${order} آپ کے سپرد`, body: 'یہ آپ کو کام کے لیے دیا گیا ہے۔' },
        url,
      }
    : {
        en: {
          title: `${shop}: you were named on order ${order}`,
          body: 'Open it to read the comment.',
        },
        ur: {
          title: `${shop}: آرڈر ${order} پر آپ کا ذکر ہوا`,
          body: 'تبصرہ پڑھنے کے لیے کھولیں۔',
        },
        url,
      };
}

/** "Zari: 25 orders are yours", opening the member's own orders (ADR-634). */
function manyGivenMessage(shop: string, size: number, url: string): PushMessage {
  return {
    en: { title: `${shop}: ${size} orders are yours`, body: 'They were given to you to work on.' },
    ur: { title: `${shop}: ${size} آرڈرز آپ کے سپرد`, body: 'یہ آپ کو کام کے لیے دیے گئے ہیں۔' },
    url,
  };
}

/** What `event` tells staff of, if anything. Taking an order for oneself needs no telling. */
function alertOf(event: DomainEvent): Alert | null {
  switch (event.type) {
    case OrderEvents.OrderAssigned: {
      const { assigneeId, assignedBy, batch } = event.payload as Partial<OrderAssignedPayload>;
      if (!assigneeId || assigneeId === assignedBy) return null;
      return {
        kind: 'order_assigned',
        orderId: event.aggregateId,
        assigneeId,
        batch: batch && batch.size > 1 ? batch : null,
      };
    }
    case OrderEvents.OrderCommentCreated:
    case OrderEvents.OrderCommentUpdated: {
      const { orderId } = event.payload as Partial<OrderCommentPayload>;
      if (!orderId) return null;
      return { kind: 'order_mentioned', orderId, commentId: event.aggregateId };
    }
    case OrderEvents.OrderUpdated: {
      // A receipt its customer sent through their link (ADR-080), not any other change.
      const { changed } = event.payload as Partial<OrderUpdatedPayload>;
      if (!changed?.includes('transferReceipt')) return null;
      return { kind: 'order_receipt_sent', orderId: event.aggregateId };
    }
    case OrderEvents.FulfillmentUpdated: {
      // Refused, or not delivered, as it turns back alone (ADR-672).
      const parcel = event.payload as Partial<FulfillmentUpdatedPayload>;
      if (parcel.status !== 'returning' || !parcel.changed?.includes('status')) return null;
      if (!parcel.orderId) return null;
      return {
        kind: 'customer_refused',
        orderId: parcel.orderId,
        fulfillmentId: event.aggregateId,
      };
    }
    default:
      return null;
  }
}

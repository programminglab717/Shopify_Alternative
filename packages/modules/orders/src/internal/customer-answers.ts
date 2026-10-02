import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import { ORDER_LINK_PATH, newLinkToken } from './links.js';
import { orderSettingsIn } from './order-settings.service.js';
import { addTimelineEntry, lockOrder, updateOrder } from './order-store.js';
import { OrderService } from './order.service.js';
import { awaitsCustomer, cancellableByCustomer } from './rules.js';

// What an order's customer answers to the shop's messages (COD-01, ADR-147): the order confirmed
// or cancelled as their link would, from the worker, which hears the buttons they press on
// WhatsApp. Each goes on the order's timeline as done by them, through the system.

/** An answer to a message asking the customer to confirm their order. */
export type CustomerAnswer = 'confirm' | 'cancel';

/** What became of an answer. */
export type AnswerOutcome =
  /** Done, as asked. */
  | 'confirmed'
  | 'cancelled'
  /** Already so, or nothing to do: confirming an order confirmed, or cancelled. */
  | 'unchanged'
  /** Too late to cancel by themselves: packed, or as the shop's settings say. On the timeline. */
  | 'too_late'
  | 'not_found';

/**
 * A new link for an open order's customer, for a message to carry (ADR-147): the path of its
 * page on the public site, "/o/…". It replaces the order's previous link, as `orderLinkCreate`
 * does. Null for an order that cannot have one: gone, not open, or its customer erased.
 */
export async function messageLinkIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  via: string,
): Promise<string | null> {
  const order = await lockOrder(tx, shopId, orderId);
  if (!order || order.status !== 'open' || order.phone === null) return null;
  const { token, hash } = newLinkToken();
  const updated = await updateOrder(tx, shopId, order, {
    linkTokenHash: hash,
    linkExpiresAt: null,
  });
  await addTimelineEntry(tx, shopId, order.id, 'system', 'link', `Sent the customer a link ${via}`);
  await appendEvent<OrderUpdatedPayload>(tx, shopId, {
    type: OrderEvents.OrderUpdated,
    aggregateType: 'order',
    aggregateId: order.id,
    payload: { changed: ['link'], stage: updated.stage, version: updated.version },
  });
  return `/${ORDER_LINK_PATH}/${token}`;
}

@Injectable()
export class CustomerAnswers {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
  ) {}

  /**
   * The customer's answer `via` a channel, "on WhatsApp": the order confirmed while it waits for
   * them, or cancelled while they may cancel it, as through their link (ADR-032, ADR-087). A
   * cancellation asked for too late stays on the timeline, for the shop to see.
   */
  async answer(
    shopId: string,
    orderId: string,
    answer: CustomerAnswer,
    via: string,
  ): Promise<AnswerOutcome> {
    return this.db.tenant(shopId, async (tx) => {
      const order = await lockOrder(tx, shopId, orderId);
      if (!order) return 'not_found';
      if (answer === 'confirm') {
        if (!awaitsCustomer(order)) return 'unchanged';
        const done = await this.orders.confirmLocked(tx, shopId, order, {
          actor: 'system',
          message: `Confirmed by the customer ${via}`,
        });
        return done.ok ? 'confirmed' : 'unchanged';
      }
      if (order.status === 'cancelled') return 'unchanged';
      const settings = await orderSettingsIn(tx, shopId);
      if (!cancellableByCustomer(order, settings.customerCancellation)) {
        await addTimelineEntry(
          tx,
          shopId,
          order.id,
          'system',
          'customer_request',
          `The customer asked ${via} to cancel the order, too late to cancel it themselves`,
        );
        return 'too_late';
      }
      const declined = awaitsCustomer(order);
      const done = await this.orders.cancelLocked(tx, shopId, order, {
        actor: 'system',
        reason: 'customer',
        message: declined
          ? `Cancelled by the customer ${via}`
          : `Cancelled by the customer ${via}, after confirming it`,
        declined,
      });
      return done.ok ? 'cancelled' : 'unchanged';
    });
  }

  /** What the customer asked `via` a channel, on the order's timeline: "to change the address". */
  async note(shopId: string, orderId: string, asked: string, via: string): Promise<boolean> {
    return this.db.tenant(shopId, async (tx) => {
      const order = await lockOrder(tx, shopId, orderId);
      if (!order) return false;
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        'system',
        'customer_request',
        `The customer asked ${via} ${asked}`,
      );
      return true;
    });
  }
}

import { createHash } from 'node:crypto';
import { creditStoreCreditIn } from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { cashbackIn } from '@hatti/messaging/public';
import type { CurrencyCode } from '@hatti/money';
import {
  OrderEvents,
  orderCashbackFactsIn,
  type FulfillmentUpdatedPayload,
} from '@hatti/orders/public';

/** The stages of an order its customer has: delivered, or picked up (ADR-389). */
const RECEIVED = new Set(['delivered', 'completed']);

/** A minor unit's worth of rupees: cashback is given in whole rupees, rounded down. */
const RUPEE = 100n;

/**
 * The ID of the credit an order's cashback is: the same however often it is asked for, so that it
 * is given once (ADR-453).
 */
export function cashbackCreditId(orderId: string): string {
  const hex = createHash('sha256').update(`cashback:${orderId}`).digest('hex');
  // A UUID's version 8, for one of the caller's own making, and its variant.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Cashback (PAY-13, ADR-453): while the shop's recipe is on, once an order is delivered or picked
 * up, and paid in full, and not cancelled, its customer is given its share of what the order's
 * goods came to, after its discount, in store credit, in whole rupees, lasting the recipe's days;
 * checkout spends it, and WhatsApp tells them of it (ADR-192). Its delivery and its payment are
 * both heard, in whichever order they come; the credit is given once.
 */
export class CashbackRewards {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderPaid,
    OrderEvents.FulfillmentUpdated,
  ];

  constructor(private readonly database: Database) {}

  /** The cashback the order earned, given once; null when it earned none. */
  async handle(event: DomainEvent, at: Date = new Date()): Promise<bigint | null> {
    let orderId = event.aggregateId;
    if (event.type === OrderEvents.FulfillmentUpdated) {
      const payload = event.payload as Partial<FulfillmentUpdatedPayload>;
      if (!payload.orderId || payload.status !== 'delivered') return null;
      orderId = payload.orderId;
    }
    const { shopId } = event;
    return this.database.tenant(shopId, async (tx) => {
      const cashback = await cashbackIn(tx, shopId);
      if (!cashback) return null;
      const order = await orderCashbackFactsIn(tx, shopId, orderId);
      if (
        !order ||
        order.erased ||
        order.status === 'cancelled' ||
        !RECEIVED.has(order.stage) ||
        order.amountPaid < order.total
      ) {
        return null;
      }
      const amount = ((order.goods * BigInt(cashback.percent)) / 100n / RUPEE) * RUPEE;
      if (amount <= 0n) return null;
      const id = cashbackCreditId(order.id);
      const given = await creditStoreCreditIn(
        tx,
        { shopId, actor: 'system' },
        {
          id,
          customerId: order.customerId,
          currency: order.currency as CurrencyCode,
          amount,
          event: 'adjustment',
          orderId: order.id,
          expiresAt: new Date(at.getTime() + cashback.days * 86_400_000),
          note: `Cashback: ${cashback.percent}% of order #${order.number}`,
        },
        ['orderId'],
        at,
      );
      return given.ok ? amount : null;
    });
  }
}

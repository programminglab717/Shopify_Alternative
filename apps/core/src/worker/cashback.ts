import { createHash } from 'node:crypto';
import { giftCardProductIdsIn } from '@hatti/catalog/public';
import { creditStoreCreditIn, takeBackOrderCreditIn } from '@hatti/customers/public';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { cashbackIn } from '@hatti/messaging/public';
import type { CurrencyCode } from '@hatti/money';
import {
  OrderEvents,
  orderCashbackFactsIn,
  type FulfillmentUpdatedPayload,
  type OrderCashbackFacts,
} from '@hatti/orders/public';
import { sql } from 'drizzle-orm';

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
 * both heard, in whichever order they come; the credit is given once. Gift cards earn none: a
 * card is money, not goods (ADR-805). Refunded, the share of its cashback the refunds took is
 * taken back, as far as what is left of that credit goes: what its customer spent of it stays
 * spent. (A delivered order can't be cancelled.)
 */
export class CashbackRewards {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderPaid,
    OrderEvents.FulfillmentUpdated,
    OrderEvents.OrderRefunded,
  ];

  constructor(private readonly database: Database) {}

  /**
   * The cashback the order earned, given once; null when it earned none. Refunded, what was
   * taken back of it, negative.
   */
  async handle(event: DomainEvent, at: Date = new Date()): Promise<bigint | null> {
    if (event.type === OrderEvents.OrderRefunded) return this.takeBack(event, at);
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
      const amount =
        (((await earning(tx, shopId, order)) * BigInt(cashback.percent)) / 100n / RUPEE) * RUPEE;
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

  /** Takes back what the order's cashback no longer earns, once it is refunded. */
  private async takeBack(event: DomainEvent, at: Date): Promise<bigint | null> {
    const { shopId, aggregateId: orderId } = event;
    return this.database.tenant(shopId, async (tx) => {
      const order = await orderCashbackFactsIn(tx, shopId, orderId);
      if (!order) return null;
      const id = cashbackCreditId(order.id);
      // What of the credit the order still earns: the share of it the refunds left, in whole
      // rupees, rounded down.
      const { rows } = await tx.execute<{ amount: string }>(
        sql`SELECT amount::text AS amount FROM customers.store_credit_transactions
             WHERE shop_id = ${shopId} AND id = ${id} AND kind = 'credit'`,
      );
      if (!rows[0]) return null;
      const given = BigInt(rows[0].amount);
      const kept =
        order.total <= 0n || order.amountRefunded >= order.total
          ? 0n
          : ((given * (order.total - order.amountRefunded)) / order.total / RUPEE) * RUPEE;
      const taken = await takeBackOrderCreditIn(
        tx,
        shopId,
        'system',
        {
          creditId: id,
          orderId: order.id,
          keep: kept,
          note: `Cashback taken back: order #${order.number} refunded`,
        },
        at,
      );
      return taken > 0n ? -taken : null;
    });
  }
}

/**
 * What of the order's goods earn cashback: all but its gift cards, its discount shared over its
 * lines as their totals are (ADR-805).
 */
async function earning(tx: Tx, shopId: string, order: OrderCashbackFacts): Promise<bigint> {
  const cards = await giftCardProductIdsIn(
    tx,
    shopId,
    order.lines.map((line) => line.productId).filter(Boolean),
  );
  if (cards.size === 0 || order.subtotal <= 0n) return order.goods;
  const carded = order.lines
    .filter((line) => cards.has(line.productId))
    .reduce((sum, line) => sum + line.total, 0n);
  return (order.goods * (order.subtotal - carded)) / order.subtotal;
}

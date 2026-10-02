import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { OrderEvents, type OrderPaidPayload } from './events.js';
import { addTimelineEntry, lockOrder, updateOrder } from './order-store.js';
import { orderName, transferOwed } from './rules.js';
import type { OrderStatusValue } from './schema.js';

/**
 * Taking an order's money online through the shop's own gateway (PAY-01, PAY-04, ADR-151), as the
 * payments module does it for the order's page. The host application provides it; without it,
 * the page offers transfers alone.
 */
export abstract class OnlinePayments {
  /** The gateway the shop takes `currency` online through; null if none. */
  abstract gatewayOf(tx: Tx, shopId: string, currency: CurrencyCode): Promise<OnlineGateway | null>;

  /**
   * Starts paying online what the order waits for: the gateway's page to send the customer to,
   * or why it cannot. `returnUrl` brings them back once they paid, `cancelUrl` if they did not.
   */
  abstract start(
    shopId: string,
    orderId: string,
    urls: { returnUrl: string; cancelUrl: string },
  ): Promise<{ url: string } | { error: string }>;

  /**
   * The customer came back from the gateway with `form`, as it sent them: `paid` once the
   * gateway's signature says a payment of the order's is made, and it is recorded; `test` if that
   * payment was a test in the gateway's sandbox, which pays nothing; null if nothing says so yet.
   */
  abstract returned(
    shopId: string,
    orderId: string,
    form: Readonly<Record<string, string>>,
  ): Promise<'paid' | 'test' | null>;
}

/** A gateway the shop takes money online through, as pages offering it show it. */
export interface OnlineGateway {
  /** By name, such as "Safepay"; "Safepay (test)" in its sandbox. */
  name: string;
  /**
   * Where its checkout pages are, by origin, which a page sending customers there lets its form
   * go on to (browsers hold a form's redirect to the page's policy); null for the page's own.
   */
  origin: string | null;
}

/** What paying an order online needs to know of it. */
export interface OrderPaymentFacts {
  id: string;
  number: number;
  /** "#1043". */
  name: string;
  status: OrderStatusValue;
  currency: CurrencyCode;
  /** Minor units: what it waits for before it ships, by transfer or online; 0 when nothing. */
  awaited: bigint;
}

/** The order `orderId` as a payment of it reads it; null if it is gone. */
export async function orderPaymentFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderPaymentFacts | null> {
  const order = await lockOrder(tx, shopId, orderId);
  if (!order) return null;
  return {
    id: order.id,
    number: order.number,
    name: orderName(order.number),
    status: order.status,
    currency: order.currency as CurrencyCode,
    // As its page offers it: before anything ships, once confirmed.
    awaited:
      order.status === 'open' && order.stage === 'awaiting_payment' ? transferOwed(order) : 0n,
  };
}

/** What recording an online payment on its order did. */
export interface OnlinePaymentReceipt {
  /** Minor units: what of it went towards what the order owed. */
  applied: bigint;
  /** What was paid beyond that, for the shop to give back: on an order paid already or closed. */
  excess: bigint;
}

/**
 * Records `amount` paid online through `gateway` on the order, in the caller's transaction, the
 * order locked: at most what it owes is paid on it, as staff record a payment, and what was paid
 * beyond that, or on an order no longer open, goes on its timeline for the shop to give back.
 * Done by the system: the gateway said the customer paid.
 */
export async function receiveOnlinePaymentIn(
  tx: Tx,
  shopId: string,
  payment: {
    orderId: string;
    amount: bigint;
    gateway: string;
    reference: string | null;
    /** A test in the gateway's sandbox: no money moved, so nothing is paid on the order. */
    test?: boolean;
  },
): Promise<OnlinePaymentReceipt | null> {
  const order = await lockOrder(tx, shopId, payment.orderId);
  if (!order) return null;
  const currency = order.currency as CurrencyCode;
  const rupees = (value: bigint) => formatMoney(money(value, currency));
  const via = `online through ${payment.gateway}${payment.reference ? `, reference ${payment.reference}` : ''}`;
  if (payment.test) {
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      'system',
      'payment_test',
      `${rupees(payment.amount)} paid ${via}, in its sandbox: a test, so nothing is paid on the order`,
    );
    return { applied: 0n, excess: 0n };
  }
  const owed = order.status === 'open' ? order.total - order.amountPaid : 0n;
  const applied = owed > 0n ? (payment.amount < owed ? payment.amount : owed) : 0n;
  const excess = payment.amount - applied;
  if (applied > 0n) {
    const paid = order.amountPaid + applied;
    const full = paid === order.total;
    const updated = await updateOrder(
      tx,
      shopId,
      order,
      {
        amountPaid: paid,
        financialStatus: !full
          ? 'partially_paid'
          : order.amountRefunded > 0n
            ? 'partially_refunded'
            : 'paid',
      },
      full ? ['paidAt'] : [],
    );
    // Its advance, when this is what makes it up.
    const advance = order.advanceDue > 0n && order.amountPaid < order.advanceDue;
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      'system',
      'paid',
      `${rupees(applied)} paid ${via}` +
        (advance && paid >= order.advanceDue ? ': the advance it asked for' : '') +
        (full ? ', paying it in full' : ''),
    );
    await appendEvent<OrderPaidPayload>(tx, shopId, {
      type: OrderEvents.OrderPaid,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { amountPaid: paid.toString(), stage: updated.stage, version: updated.version },
    });
  }
  if (excess > 0n) {
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      'system',
      'payment_excess',
      `${rupees(excess)} paid ${via} beyond what ${orderName(order.number)} owed` +
        (order.status === 'open' ? '' : ` as a ${order.status} order`) +
        ': give it back to the customer',
    );
  }
  return { applied, excess };
}

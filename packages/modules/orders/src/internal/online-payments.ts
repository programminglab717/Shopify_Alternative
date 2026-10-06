import type { MutationResult, TenantContext } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, type PkProvinceCode } from '@hatti/pk';
import { and, asc, eq } from 'drizzle-orm';
import { OrderEvents, type OrderPaidPayload } from './events.js';
import type { GatewayFormStart } from './online-payment-page.js';
import type { PrepaidDiscountValue } from './prepaid-discount.js';
import { addTimelineEntry, lockOrder, updateOrder } from './order-store.js';
import { itemName, orderName, transferOwed } from './rules.js';
import { lines, orders, type OrderStatusValue } from './schema.js';

/**
 * Taking an order's money online through the shop's own gateway (PAY-01, PAY-04, ADR-151), as the
 * payments module does it for the order's page. The host application provides it; without it,
 * the page offers transfers alone.
 */
export abstract class OnlinePayments {
  /**
   * The gateways the shop takes `currency` online through, for the customer to choose among
   * (ADR-219): each of its live accounts that takes it, in the order the shop puts them
   * (ADR-221); none if it takes it online through none.
   */
  abstract gatewaysOf(tx: Tx, shopId: string, currency: CurrencyCode): Promise<OnlineGateway[]>;

  /**
   * What the shop takes off the items of orders paid online at checkout, after any code, as its
   * prepaid incentive (PAY-05, ADR-222); null for nothing. Checkout offers it with
   * {@link gatewaysOf}'s gateways, and an order placed online keeps what it took off.
   */
  abstract discountOf(tx: Tx, shopId: string): Promise<PrepaidDiscountValue | null>;

  /**
   * Starts paying online what the order waits for, through `gateway`, one of the shop's as
   * {@link gatewaysOf} gives them, or the first of them when not given (ADR-219): the gateway's
   * page to send the customer to, with the fields their browser posts there where its page takes
   * a form (ADR-163); or why it cannot. `returnUrl` brings them back once they paid, `cancelUrl`
   * if they did not.
   */
  abstract start(
    shopId: string,
    orderId: string,
    urls: { returnUrl: string; cancelUrl: string },
    gateway?: string | null,
  ): Promise<{ url: string; form?: Readonly<Record<string, string>> } | { error: string }>;

  /**
   * The customer came back from the gateway with `form`, as it sent them, to `returnUrl`: `paid`
   * once the gateway's signature, or its inquiry where its return is not signed, says a payment
   * of the order's is made, and it is recorded; `test` if that payment was a test in the
   * gateway's sandbox, which pays nothing; the gateway's next page, with the fields the
   * customer's browser posts there and the gateway's name, where they came back partway
   * (ADR-214); null if nothing says so yet.
   */
  abstract returned(
    shopId: string,
    orderId: string,
    form: Readonly<Record<string, string>>,
    returnUrl: string,
  ): Promise<'paid' | 'test' | GatewayFormStart | null>;

  /**
   * Gives back `amount`, in minor units, of what the order's customer paid online, through the
   * gateway that took it (PAY-06, ADR-153): the order's refund, once the gateway says it is sent
   * and it is recorded with {@link refundOnlinePaymentIn}; or why not, as the API's errors.
   */
  abstract refund(
    tenant: TenantContext,
    orderId: string,
    request: { amount: bigint; note: string },
  ): Promise<MutationResult<{ refundId: string | null }>>;
}

/** A gateway the shop takes money online through, as pages offering it show it. */
export interface OnlineGateway {
  /**
   * Which it is, such as "jazzcash": what a page's form posts to pay through it (ADR-219). A shop
   * has one live account a gateway, so it names the account too.
   */
  gateway: string;
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
  /** Minor units: what was paid on it and not refunded yet. */
  refundable: bigint;
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
    refundable: order.amountPaid - order.amountRefunded,
  };
}

/**
 * Who pays for an order, and for what, as gateways that ask take them with a checkout (ADR-226):
 * its customer's name, number and email, where it goes, its items at their prices and its
 * delivery charge. What an erasure took off is null.
 */
export interface OrderBuyerFacts {
  name: string | null;
  /** E.164: "+923001234567". */
  phone: string | null;
  email: string | null;
  address: {
    address1: string;
    /** The area: "Gulshan-e-Iqbal". */
    address2: string | null;
    city: string;
    /** "Punjab", as `@hatti/pk` names it. */
    province: string | null;
    zip: string | null;
  } | null;
  lines: { name: string; sku: string | null; quantity: number; unitPrice: bigint }[];
  /** Minor units. */
  shipping: bigint;
}

/** The order `orderId`'s buyer, in the caller's transaction; null if it is gone. */
export async function orderBuyerIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderBuyerFacts | null> {
  const [order] = await tx
    .select({
      phone: orders.phone,
      email: orders.email,
      address: orders.shippingAddress,
      shipping: orders.shipping,
    })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
  if (!order) return null;
  const items = await tx
    .select({
      title: lines.title,
      variantTitle: lines.variantTitle,
      sku: lines.sku,
      quantity: lines.quantity,
      unitPrice: lines.unitPrice,
    })
    .from(lines)
    .where(and(eq(lines.shopId, shopId), eq(lines.orderId, orderId)))
    .orderBy(asc(lines.position));
  const { address } = order;
  return {
    name: address.name,
    phone: order.phone ?? address.phone,
    email: order.email,
    address:
      address.address1 === null
        ? null
        : {
            address1: address.address1,
            address2: address.address2,
            city: address.city,
            province:
              address.provinceCode && address.provinceCode in PK_PROVINCES
                ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
                : null,
            zip: address.zip,
          },
    lines: items.map((line) => ({
      name: itemName(line),
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
    shipping: order.shipping,
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

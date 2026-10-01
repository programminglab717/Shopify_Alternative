import { createHash } from 'node:crypto';
import type { CurrencyCode } from '@hatti/money';
import { maskPkMobile } from '@hatti/pk';
import { taxByRate } from './order-tax.js';
import type { DraftOrderRecord, OrderRecord } from './records.js';
import { transferOwed } from './rules.js';
import type { StoredAddressValue } from './schema.js';

/**
 * What a customer's page shows of a draft or an order: its items, what they come to, and where
 * they go.
 */
export interface ShownOrder {
  currency: CurrencyCode;
  lines: { title: string; variantTitle: string; quantity: number; total: bigint }[];
  /** Minor units. */
  subtotal: bigint;
  discount: bigint;
  /** Of `discount`, what paying by transfer took off: an order's, as checkout took it. */
  transferDiscount: bigint;
  shipping: bigint;
  /** For paying on delivery: an order's, as checkout added it; a draft has none. */
  codFee: bigint;
  total: bigint;
  /**
   * The sales tax its total includes, by rate (ADR-096): an order's; a draft's is worked out when
   * it is placed.
   */
  taxes: { rate: number; tax: bigint }[];
  /** Paid already: an advance on cash on delivery, or a prepaid or paid transfer's total. */
  paid: bigint;
  /** To pay at the door. */
  due: bigint;
  /**
   * To pay by bank transfer: what a bank-transfer order still waits for, or the advance a
   * cash-on-delivery order or draft asks for (ADR-083, ADR-085).
   */
  transfer: bigint;
  cashOnDelivery: boolean;
  /** Null for a draft without one yet. */
  address: StoredAddressValue | null;
}

export function shownOfDraft(draft: DraftOrderRecord): ShownOrder {
  return {
    currency: draft.currency,
    lines: draft.lines,
    subtotal: draft.subtotal,
    discount: draft.discount,
    transferDiscount: 0n,
    shipping: draft.shipping,
    codFee: 0n,
    total: draft.total,
    taxes: [],
    paid: draft.advancePaid,
    due: draft.codAmount,
    // A draft's link is for cash on delivery alone, with the advance it asks for, if any.
    transfer: draft.advanceDue,
    cashOnDelivery: draft.paymentMethod === 'cash_on_delivery',
    address: draft.shippingAddress,
  };
}

export function shownOfOrder(order: OrderRecord): ShownOrder {
  const cashOnDelivery = order.paymentMethod === 'cash_on_delivery';
  // What is still owed: an order marked paid before it arrives has nothing left to pay. Of it,
  // what waits for a transfer: a bank-transfer order's, or a cash-on-delivery order's advance.
  const owed = order.total - order.amountPaid;
  const transfer = transferOwed(order);
  return {
    currency: order.currency,
    lines: order.lines,
    subtotal: order.subtotal,
    discount: order.discount,
    transferDiscount: order.transferDiscount,
    shipping: order.shipping,
    codFee: order.codFee,
    total: order.total,
    taxes: [...taxByRate(order)].map(([rate, tax]) => ({ rate, tax })),
    paid: order.amountPaid,
    due: cashOnDelivery ? owed - transfer : 0n,
    transfer,
    cashOnDelivery,
    address: order.shippingAddress,
  };
}

/**
 * A digest of what the page showed, which the customer's confirmation carries: if the items, the
 * amounts or the address changed since, the page shows them again rather than confirming what
 * the customer did not see. Changes they cannot see, such as a note, do not count. It is made of
 * what the page shows, the number masked, so it gives nothing more away.
 */
export function shownDigest(shown: ShownOrder): string {
  const address = shown.address;
  const text = JSON.stringify([
    shown.currency,
    shown.lines.map((line) => [line.title, line.variantTitle, line.quantity, `${line.total}`]),
    [shown.subtotal, shown.discount, shown.shipping, shown.total, shown.paid, shown.due].map(
      (amount) => `${amount}`,
    ),
    shown.cashOnDelivery,
    address && [
      address.name,
      address.phone && maskPkMobile(address.phone),
      address.address1,
      address.address2,
      address.landmark,
      address.city,
      address.provinceCode,
      address.zip,
    ],
  ]);
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

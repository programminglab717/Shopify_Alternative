import { createHash } from 'node:crypto';
import type { CurrencyCode } from '@hatti/money';
import { maskPkMobile } from '@hatti/pk';
import type { DraftOrderRecord, OrderRecord } from './records.js';
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
  shipping: bigint;
  total: bigint;
  /** Paid already: an advance on cash on delivery, or a prepaid order's total. */
  paid: bigint;
  /** To pay at the door. */
  due: bigint;
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
    shipping: draft.shipping,
    total: draft.total,
    paid: draft.advancePaid,
    due: draft.codAmount,
    cashOnDelivery: draft.paymentMethod === 'cash_on_delivery',
    address: draft.shippingAddress,
  };
}

export function shownOfOrder(order: OrderRecord): ShownOrder {
  const cashOnDelivery = order.paymentMethod === 'cash_on_delivery';
  // What is still owed: an order marked paid before it arrives has nothing left to pay.
  const owed = order.total - order.amountPaid;
  return {
    currency: order.currency,
    lines: order.lines,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shipping,
    total: order.total,
    paid: order.amountPaid,
    due: cashOnDelivery && owed > 0n ? owed : 0n,
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

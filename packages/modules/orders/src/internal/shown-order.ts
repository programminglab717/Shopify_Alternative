import { createHash } from 'node:crypto';
import type { CurrencyCode } from '@hatti/money';
import type { PolicyType } from '@hatti/online-store/public';
import { maskPkMobile } from '@hatti/pk';
import { taxByRate, type DraftTax } from './order-tax.js';
import type { DraftOrderRecord, LineBundle, OrderRecord } from './records.js';
import { itemName, transferOwed } from './rules.js';
import type { StoredAddressValue } from './schema.js';

/**
 * What a customer's page shows of a draft or an order: its items, what they come to, and where
 * they go.
 */
export interface ShownOrder {
  currency: CurrencyCode;
  lines: {
    title: string;
    variantTitle: string;
    quantity: number;
    total: bigint;
    /** The day it ships by, its product on pre-order when it was sold (ADR-403). */
    preorderShipsOn?: string | null;
    /** The bundle it was sold as a part of (ADR-410); a draft's lines have none. */
    bundle?: LineBundle | null;
  }[];
  /** Minor units. */
  subtotal: bigint;
  discount: bigint;
  /** Of `discount`, what paying by transfer took off: an order's, as checkout took it. */
  transferDiscount: bigint;
  /** And what paying online took off (ADR-222). */
  onlineDiscount: bigint;
  shipping: bigint;
  /** For paying on delivery: an order's, as checkout added it; a draft has none. */
  codFee: bigint;
  total: bigint;
  /**
   * The sales tax its total includes, by rate (ADR-096): an order's, as it was placed; an open
   * draft's at the shop's rates now, as placing it would work it out (ADR-106).
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
  /** To pay online: what an order paid online still waits for (ADR-152); a draft's, nothing. */
  online: bigint;
  cashOnDelivery: boolean;
  /** Collected by the customer at a location rather than delivered (ADR-389, ADR-390). */
  pickup: boolean;
  /** Null for a draft without one yet. */
  address: StoredAddressValue | null;
  /**
   * The shop's policies the page says confirming agrees to, each linked: an open draft's
   * (ADR-114), or an order's that waits for its customer and keeps nothing they agreed to
   * (ADR-115).
   */
  terms: ShownTerm[];
}

/** A policy confirming agrees to, as a link's page links it (ADR-114). */
export interface ShownTerm {
  type: PolicyType;
  /** The version its body is now: what the order keeps (ADR-057). */
  versionId: string;
  /** Where the shop's storefront shows it. */
  url: string;
}

export function shownOfDraft(
  draft: DraftOrderRecord,
  tax: DraftTax,
  terms: readonly ShownTerm[] = [],
): ShownOrder {
  return {
    currency: draft.currency,
    lines: draft.lines,
    subtotal: draft.subtotal,
    discount: draft.discount,
    transferDiscount: 0n,
    onlineDiscount: 0n,
    shipping: draft.shipping,
    codFee: 0n,
    total: draft.total,
    taxes: [...tax.byRate].map(([rate, amount]) => ({ rate, tax: amount })),
    paid: draft.advancePaid,
    due: draft.codAmount,
    // Paid on delivery, with the advance it asks for, if any; or by transfer, all of it (ADR-223).
    transfer: draft.paymentMethod === 'bank_transfer' ? draft.total : draft.advanceDue,
    online: 0n,
    cashOnDelivery: draft.paymentMethod === 'cash_on_delivery',
    pickup: draft.deliveryMethod === 'pickup',
    address: draft.shippingAddress,
    terms: [...terms],
  };
}

export function shownOfOrder(order: OrderRecord, terms: readonly ShownTerm[] = []): ShownOrder {
  const cashOnDelivery = order.paymentMethod === 'cash_on_delivery';
  // What is still owed: an order marked paid before it arrives has nothing left to pay. Of it,
  // what waits for a transfer: a bank-transfer order's, or a cash-on-delivery order's advance;
  // or, paid online, what waits for that.
  const owed = order.total - order.amountPaid;
  const awaited = transferOwed(order);
  const online = order.paymentMethod === 'online' ? awaited : 0n;
  const transfer = awaited - online;
  return {
    currency: order.currency,
    lines: order.lines,
    subtotal: order.subtotal,
    discount: order.discount,
    transferDiscount: order.transferDiscount,
    onlineDiscount: order.onlineDiscount,
    shipping: order.shipping,
    codFee: order.codFee,
    total: order.total,
    taxes: [...taxByRate(order)].map(([rate, tax]) => ({ rate, tax })),
    paid: order.amountPaid,
    due: cashOnDelivery ? owed - transfer : 0n,
    transfer,
    online,
    cashOnDelivery,
    pickup: order.deliveryMethod === 'pickup',
    address: order.shippingAddress,
    terms: [...terms],
  };
}

/**
 * A digest of what the page showed, which the customer's confirmation carries: if the items, the
 * amounts, the tax they include, the address or the versions of the policies it linked changed
 * since, the page shows them again rather than confirming what the customer did not see. Changes they cannot see, such as a note, do not
 * count. It is made of what the page shows, the number masked, so it gives nothing more away.
 */
export function shownDigest(shown: ShownOrder): string {
  const address = shown.address;
  const text = JSON.stringify([
    shown.currency,
    shown.lines.map((line) => [line.title, line.variantTitle, line.quantity, `${line.total}`]),
    [shown.subtotal, shown.discount, shown.shipping, shown.total, shown.paid, shown.due].map(
      (amount) => `${amount}`,
    ),
    shown.taxes.map((tax) => [tax.rate, `${tax.tax}`]),
    shown.cashOnDelivery,
    shown.pickup,
    address && [
      address.name,
      address.phone && maskPkMobile(address.phone),
      address.address1,
      address.address2,
      address.landmark,
      address.city,
      address.provinceCode,
      address.zip,
      // Its pin, where it has one: digests of addresses without stay as they were.
      ...(address.location ? [address.location.latitude, address.location.longitude] : []),
    ],
    shown.terms.map((term) => term.versionId),
  ]);
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

/** A row of a customer's page: a line, or a bundle with its parts' lines (ADR-411). */
export type ShownItem =
  | { line: ShownOrder['lines'][number] }
  | {
      bundle: {
        title: string;
        /** How many of it were ordered. */
        quantity: number;
        /** What its parts' lines come to. */
        total: bigint;
        /** Each part once, as "Lawn shirt (M)", with its units in the order. */
        parts: { name: string; quantity: number }[];
      };
    };

/**
 * An order's lines as its customer's page shows them (ADR-411): each bundle once, where its first
 * part's line is, its parts' lines its own; any other line as it is.
 */
export function shownItems(lines: ShownOrder['lines']): ShownItem[] {
  const items: ShownItem[] = [];
  const bundles = new Map<string, Extract<ShownItem, { bundle: unknown }>['bundle']>();
  for (const line of lines) {
    if (!line.bundle) {
      items.push({ line });
      continue;
    }
    let bundle = bundles.get(line.bundle.key);
    if (!bundle) {
      bundle = { title: line.bundle.title, quantity: line.bundle.quantity, total: 0n, parts: [] };
      bundles.set(line.bundle.key, bundle);
      items.push({ bundle });
    }
    bundle.total += line.total;
    // A part's price shared to the paisa may make it two lines (ADR-410): one part, here.
    const name = itemName(line);
    const part = bundle.parts.find((each) => each.name === name);
    if (part) part.quantity += line.quantity;
    else bundle.parts.push({ name, quantity: line.quantity });
  }
  return items;
}

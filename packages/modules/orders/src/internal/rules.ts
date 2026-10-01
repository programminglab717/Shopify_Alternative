import type { FieldError } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import { formatMoney, money } from '@hatti/money';
import type {
  ConfirmationStatusValue,
  CustomerCancellationValue,
  FulfillmentStatusValue,
  OrderStageValue,
  OrderStatusValue,
  PaymentMethodValue,
} from './schema.js';

export const LIMITS = {
  /** Lines per order. */
  lines: 100,
  /** Units per line. */
  quantity: 10_000,
  name: 255,
  addressLine: 255,
  note: 5_000,
  /** A comment on an order's timeline (ADR-128), as an event's message may be. */
  comment: 2_000,
  /** A refund's transfer reference. */
  reference: 100,
  /** Orders per bulk request. */
  batch: 250,
  /** A saved search's name, as the tab it names shows it (ADR-119). */
  savedSearchName: 40,
  savedSearchQuery: 1_000,
  /** Saved searches per shop. */
  savedSearches: 100,
} as const;

/**
 * The most cash an order may collect on delivery, in paisa (TAX-07): Income Tax Circular 02 of
 * 2025-26 caps cash payments at Rs 200,000 an order. It binds orders in rupees, whoever places
 * them; a change in the law is a change here.
 */
export const COD_CASH_LIMIT = 200_000_00n;

/**
 * Why a cash-on-delivery order of `total`, with `advance` paid, cannot be placed: it would collect
 * more than {@link COD_CASH_LIMIT} at the door. Null when it can.
 */
export function codLimitError(
  field: string[],
  order: { paymentMethod: PaymentMethodValue; currency: string; total: bigint; advance: bigint },
): FieldError | null {
  const cash = order.total - order.advance;
  if (order.paymentMethod !== 'cash_on_delivery' || order.currency !== 'PKR') return null;
  if (cash <= COD_CASH_LIMIT) return null;
  const rupees = (value: bigint) => formatMoney(money(value, 'PKR'));
  return {
    field,
    code: 'COD_LIMIT',
    message:
      `Cash on delivery can't collect more than ${rupees(COD_CASH_LIMIT)} an order: take an ` +
      `advance of at least ${rupees(order.total - COD_CASH_LIMIT)}, or make it prepaid`,
  };
}

/** Why an order paid `paymentMethod`'s way can't take an advance; null when it can. */
export function advanceRefusal(paymentMethod: PaymentMethodValue): string | null {
  switch (paymentMethod) {
    case 'cash_on_delivery':
      return null;
    case 'prepaid':
      return 'A prepaid order is paid in full; an advance is for cash-on-delivery orders';
    case 'bank_transfer':
      return (
        'A bank-transfer order is paid in full by its transfer; an advance is for ' +
        'cash-on-delivery orders'
      );
  }
}

/** A shop's first order number, as in Shopify. */
export const FIRST_ORDER_NUMBER = 1001;

/** "#1001": how staff and customers refer to an order. */
export function orderName(number: number): string {
  return `#${number}`;
}

/** "Peshawari Chappal (8)": an order's item; a product without options by its title alone. */
export function itemName(line: { title: string; variantTitle: string }): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE
    ? line.title
    : `${line.title} (${line.variantTitle})`;
}

/** "#D1": how staff refer to a draft order. */
export function draftName(number: number): string {
  return `#D${number}`;
}

/**
 * How long a customer's link works when made to expire, in hours. A draft's does unless given
 * otherwise; an order's lasts until {@link LINK_DAYS_AFTER_END} days after the order ends.
 */
export const LINK_HOURS = {
  /** Three days: long enough for a customer who answers the next evening. */
  default: 72,
  /** Thirty days. */
  max: 720,
} as const;

/** How long an order's link works once the order is closed or cancelled, in days. */
export const LINK_DAYS_AFTER_END = 30;

/**
 * When an order's link stops working: at its own expiry, if it was made to expire, and at the
 * latest 30 days after the order ends. Null while a link that lasts has an open order.
 */
export function orderLinkExpiry(order: {
  status: OrderStatusValue;
  linkExpiresAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
}): Date | null {
  const ended = order.status === 'open' ? null : (order.cancelledAt ?? order.closedAt);
  const afterEnd = ended && new Date(ended.getTime() + LINK_DAYS_AFTER_END * 86_400_000);
  if (!order.linkExpiresAt) return afterEnd;
  return afterEnd && afterEnd < order.linkExpiresAt ? afterEnd : order.linkExpiresAt;
}

export interface StageInputs {
  status: OrderStatusValue;
  confirmationStatus: ConfirmationStatusValue;
  paymentMethod: PaymentMethodValue;
  /** Received so far; refunds since do not change it. */
  amountPaid: bigint;
  total: bigint;
  /** What a cash-on-delivery order asks for in advance, by transfer (ADR-083); zero for none. */
  advanceDue: bigint;
  /** When it was marked packed; null while it is not. */
  packedAt: Date | null;
}

/** What an order's parcels add up to. */
export interface ParcelSummary {
  /** Units ordered, and units shipped so far. */
  units: number;
  shipped: number;
  /** Parcels, by where they are. */
  inTransit: number;
  returning: number;
  delivered: number;
  returned: number;
  /** Lost by their couriers. */
  lost: number;
}

/** An order before anything ships. */
export const NO_PARCELS: ParcelSummary = {
  units: 0,
  shipped: 0,
  inTransit: 0,
  returning: 0,
  delivered: 0,
  returned: 0,
  lost: 0,
};

/** Shipped, partly shipped or came back, from the parcels. */
export function fulfillmentStatusOf(parcels: ParcelSummary): FulfillmentStatusValue {
  const count =
    parcels.inTransit + parcels.returning + parcels.delivered + parcels.returned + parcels.lost;
  if (parcels.returned > 0) {
    return parcels.returned === count && parcels.shipped === parcels.units
      ? 'returned'
      : 'partially_returned';
  }
  if (parcels.shipped === 0) return 'unfulfilled';
  return parcels.shipped === parcels.units ? 'fulfilled' : 'partially_fulfilled';
}

/**
 * The single state merchants see, from an order's statuses and its parcels. Stored on the order
 * and recomputed on every change, so lists filter and count by it cheaply.
 */
export function stageOf(order: StageInputs, parcels: ParcelSummary = NO_PARCELS): OrderStageValue {
  if (order.status === 'cancelled' || order.confirmationStatus === 'rejected') return 'cancelled';
  if (order.confirmationStatus === 'pending' || order.confirmationStatus === 'no_response') {
    return 'needs_confirmation';
  }
  if (order.confirmationStatus === 'needs_review') return 'needs_review';
  if (parcels.shipped === 0 && awaitsTransfer(order)) return 'awaiting_payment';
  if (parcels.shipped === 0) return order.packedAt ? 'to_book' : 'to_pack';
  if (parcels.shipped < parcels.units) return 'partially_fulfilled';
  if (parcels.returning > 0) return 'returning';
  if (parcels.inTransit > 0) return 'in_transit';
  // Every parcel has arrived somewhere, or was lost: none delivered, the order is done, lost if
  // nothing came back either.
  if (parcels.delivered === 0) return parcels.returned === 0 ? 'lost' : 'returned';
  // Paid in full, even if some of it was refunded since: a refund does not reopen an order.
  return order.amountPaid >= order.total ? 'completed' : 'delivered';
}

/**
 * What an order waits for by transfer before it ships: a bank-transfer order, what it has not
 * received of its total (ADR-074); a cash-on-delivery order, what it has not received of the
 * advance it asks for (ADR-083); nothing otherwise. Refunds since do not count, so a refunded
 * transfer does not wait for its money again.
 */
export function transferOwed(order: {
  paymentMethod: PaymentMethodValue;
  amountPaid: bigint;
  total: bigint;
  advanceDue: bigint;
}): bigint {
  const awaited =
    order.paymentMethod === 'bank_transfer'
      ? order.total
      : order.paymentMethod === 'cash_on_delivery'
        ? order.advanceDue
        : 0n;
  return awaited > order.amountPaid ? awaited - order.amountPaid : 0n;
}

/** Whether an order waits for money by transfer before it ships, as {@link transferOwed} says. */
export function awaitsTransfer(order: {
  paymentMethod: PaymentMethodValue;
  amountPaid: bigint;
  total: bigint;
  advanceDue: bigint;
}): boolean {
  return transferOwed(order) > 0n;
}

/**
 * Whether a cash-on-delivery order waits for its customer to confirm it: open, nothing shipped,
 * and neither confirmed nor held for review.
 */
export function awaitsCustomer(order: {
  status: OrderStatusValue;
  paymentMethod: PaymentMethodValue;
  confirmationStatus: ConfirmationStatusValue;
  fulfillmentStatus: FulfillmentStatusValue;
}): boolean {
  return (
    order.status === 'open' &&
    order.paymentMethod === 'cash_on_delivery' &&
    (order.confirmationStatus === 'pending' || order.confirmationStatus === 'no_response') &&
    order.fulfillmentStatus === 'unfulfilled'
  );
}

/**
 * Whether the customer may still correct an order's delivery address through their link: open,
 * nothing shipped, and not packed, as a packed parcel may carry the old address on its slip.
 */
export function addressChangeable(order: {
  status: OrderStatusValue;
  fulfillmentStatus: FulfillmentStatusValue;
  packedAt: Date | null;
}): boolean {
  return (
    order.status === 'open' && order.fulfillmentStatus === 'unfulfilled' && order.packedAt === null
  );
}

/**
 * Whether the customer may cancel the order through its link, as the shop's `window` allows:
 * while a cash-on-delivery order waits for them, or, until it is packed, though they confirmed
 * it; and a bank-transfer order, or one asking for an advance, while they have paid nothing, as
 * paying is their confirming it. Only while nothing has been paid or shipped: then it is the
 * shop's to cancel.
 */
export function cancellableByCustomer(
  order: {
    status: OrderStatusValue;
    paymentMethod: PaymentMethodValue;
    confirmationStatus: ConfirmationStatusValue;
    fulfillmentStatus: FulfillmentStatusValue;
    packedAt: Date | null;
    amountPaid: bigint;
    advanceDue: bigint;
  },
  window: CustomerCancellationValue,
): boolean {
  if (awaitsCustomer(order)) return true;
  const untouched =
    order.status === 'open' &&
    order.amountPaid === 0n &&
    order.fulfillmentStatus === 'unfulfilled' &&
    order.packedAt === null;
  // Until they pay, as for a transfer: an advance is their say-so, as paying is.
  if (order.paymentMethod === 'bank_transfer' || order.advanceDue > 0n) return untouched;
  return window === 'until_packed' && order.paymentMethod === 'cash_on_delivery' && untouched;
}

/** Stages at which an order is done, so it closes. */
export function isFinalStage(stage: OrderStageValue): boolean {
  return stage === 'completed' || stage === 'returned' || stage === 'lost';
}

import type {
  ConfirmationStatusValue,
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderStageValue,
  OrderStatusValue,
} from './schema.js';

export const LIMITS = {
  /** Lines per order. */
  lines: 100,
  /** Units per line. */
  quantity: 10_000,
  name: 255,
  addressLine: 255,
  note: 5_000,
  /** Orders per bulk request. */
  batch: 250,
} as const;

/** A shop's first order number, as in Shopify. */
export const FIRST_ORDER_NUMBER = 1001;

/** "#1001": how staff and customers refer to an order. */
export function orderName(number: number): string {
  return `#${number}`;
}

export interface StageInputs {
  status: OrderStatusValue;
  confirmationStatus: ConfirmationStatusValue;
  financialStatus: FinancialStatusValue;
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
}

/** An order before anything ships. */
export const NO_PARCELS: ParcelSummary = {
  units: 0,
  shipped: 0,
  inTransit: 0,
  returning: 0,
  delivered: 0,
  returned: 0,
};

/** Shipped, partly shipped or came back, from the parcels. */
export function fulfillmentStatusOf(parcels: ParcelSummary): FulfillmentStatusValue {
  const count = parcels.inTransit + parcels.returning + parcels.delivered + parcels.returned;
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
  if (parcels.shipped === 0) return order.packedAt ? 'to_book' : 'to_pack';
  if (parcels.shipped < parcels.units) return 'partially_fulfilled';
  if (parcels.returning > 0) return 'returning';
  if (parcels.inTransit > 0) return 'in_transit';
  // Every parcel has arrived somewhere.
  if (parcels.delivered === 0) return 'returned';
  return order.financialStatus === 'paid' ? 'completed' : 'delivered';
}

/** Stages at which an order is done, so it closes. */
export function isFinalStage(stage: OrderStageValue): boolean {
  return stage === 'completed' || stage === 'returned';
}

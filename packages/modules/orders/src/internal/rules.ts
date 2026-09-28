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
  email: 254,
  note: 5_000,
  tags: 250,
  tag: 255,
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
  fulfillmentStatus: FulfillmentStatusValue;
}

/**
 * The single state merchants see, derived from an order's four statuses. Stored on the order and
 * recomputed on every change, so lists filter and count by it cheaply.
 */
export function stageOf(order: StageInputs): OrderStageValue {
  if (order.status === 'cancelled' || order.confirmationStatus === 'rejected') return 'cancelled';
  if (order.confirmationStatus === 'pending' || order.confirmationStatus === 'no_response') {
    return 'needs_confirmation';
  }
  if (order.confirmationStatus === 'needs_review') return 'needs_review';
  return 'to_fulfill';
}

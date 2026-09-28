import type {
  CancelReasonValue,
  OrderSourceValue,
  OrderStageValue,
  PaymentMethodValue,
} from './schema.js';

/**
 * Events the orders module publishes. Payloads are thin: fetch current state through the API.
 * Every event carries the order's stage and version after the change, so consumers can keep
 * counts per stage and drop stale updates.
 */
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderUpdated: 'order.updated',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
  OrderPaid: 'order.paid',
} as const;

interface OrderState {
  stage: OrderStageValue;
  version: number;
}

export interface OrderCreatedPayload extends OrderState {
  number: number;
  source: OrderSourceValue;
  paymentMethod: PaymentMethodValue;
  /** Minor units, as a string: JSON numbers lose precision above 2^53. */
  total: string;
  currency: string;
}

export interface OrderUpdatedPayload extends OrderState {
  /** Names of what changed, e.g. "shippingAddress", "note", "tags". */
  changed: string[];
}

export type OrderConfirmedPayload = OrderState;

export interface OrderCancelledPayload extends OrderState {
  reason: CancelReasonValue;
}

export interface OrderPaidPayload extends OrderState {
  /** Minor units, as a string. */
  amountPaid: string;
}

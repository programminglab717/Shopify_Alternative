import type {
  CancelReasonValue,
  OrderSourceValue,
  OrderStageValue,
  ParcelStatusValue,
  PaymentMethodValue,
} from './schema.js';

/**
 * Events the orders module publishes. Payloads are thin: fetch current state through the API.
 * Every event carries the order's stage and version after the change, so consumers can keep
 * counts per stage and drop stale updates. A parcel's events (`fulfillment.*`) carry its order's.
 */
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderUpdated: 'order.updated',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
  OrderPaid: 'order.paid',
  FulfillmentCreated: 'fulfillment.created',
  FulfillmentUpdated: 'fulfillment.updated',
} as const;

interface OrderState {
  stage: OrderStageValue;
  version: number;
}

export interface OrderCreatedPayload extends OrderState {
  number: number;
  /** The customer with the order's mobile number. */
  customerId: string;
  source: OrderSourceValue;
  paymentMethod: PaymentMethodValue;
  /** Minor units, as a string: JSON numbers lose precision above 2^53. */
  total: string;
  currency: string;
}

export interface OrderUpdatedPayload extends OrderState {
  /** Names of what changed, e.g. "shippingAddress", "note", "tags"; "customer" with a new number. */
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

/** A parcel shipped. The aggregate is the parcel. */
export interface FulfillmentCreatedPayload {
  orderId: string;
  status: ParcelStatusValue;
  trackingCompany: string | null;
  trackingNumber: string | null;
  orderStage: OrderStageValue;
  orderVersion: number;
}

/** A parcel was delivered, started coming back, came back, or its tracking changed. */
export interface FulfillmentUpdatedPayload {
  orderId: string;
  status: ParcelStatusValue;
  /** "status" or "tracking". */
  changed: string[];
  version: number;
  orderStage: OrderStageValue;
  orderVersion: number;
}

import type {
  CancelReasonValue,
  CustomerCancellationValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  OrderSourceValue,
  OrderStageValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  RiskLevelValue,
} from './schema.js';

/**
 * Events the orders module publishes. Payloads are thin: fetch current state through the API.
 * Every order event carries the order's stage and version after the change, so consumers can keep
 * counts per stage and drop stale updates. A parcel's events (`fulfillment.*`) carry its order's.
 */
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderUpdated: 'order.updated',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
  OrderPaid: 'order.paid',
  OrderRefunded: 'order.refunded',
  OrderExportCreated: 'order_export.created',
  DraftOrderCreated: 'draft_order.created',
  DraftOrderUpdated: 'draft_order.updated',
  DraftOrderDeleted: 'draft_order.deleted',
  DraftOrderCompleted: 'draft_order.completed',
  FulfillmentCreated: 'fulfillment.created',
  FulfillmentUpdated: 'fulfillment.updated',
  RiskSettingsUpdated: 'order_risk_settings.updated',
  OrderSettingsUpdated: 'order_settings.updated',
  BankTransferSettingsUpdated: 'bank_transfer_settings.updated',
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
  /** Cash-on-delivery orders only; a held one is at stage needs_review. */
  riskLevel: RiskLevelValue | null;
}

export interface OrderUpdatedPayload extends OrderState {
  /**
   * Names of what changed, e.g. "shippingAddress", "note", "tags"; "customer" with a new number,
   * "packed" when marked packed or not, "link" when a link was made for the customer.
   */
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

export interface OrderRefundedPayload extends OrderState {
  refundId: string;
  /** Minor units, as strings: this refund, and all the order's refunds so far. */
  amount: string;
  amountRefunded: string;
  method: RefundMethodValue;
}

/**
 * Orders were exported. The aggregate is the export; the filter is as the API had it, in enum
 * values and ISO 8601 dates.
 */
export interface OrderExportCreatedPayload {
  rows: number;
  /** ORDERS or LINE_ITEMS. */
  layout: string;
  query: string | null;
  stage: string | null;
  riskLevel: string | null;
  placedFrom: string | null;
  placedBefore: string | null;
  actorKind: 'app' | 'staff';
  actorId: string;
  actorRole: string | null;
}

/** A draft order's state after the change. The aggregate is the draft. */
interface DraftOrderState {
  status: DraftOrderStatusValue;
  version: number;
}

export interface DraftOrderCreatedPayload extends DraftOrderState {
  number: number;
  source: DraftOrderSourceValue;
  paymentMethod: PaymentMethodValue;
  /** Minor units, as a string. */
  total: string;
  currency: string;
}

export interface DraftOrderUpdatedPayload extends DraftOrderState {
  /**
   * Names of what changed, e.g. "lineItems", "shippingAddress", "note"; "link" when a link was
   * made for the customer, or dropped because the draft can no longer be confirmed through one.
   */
  changed: string[];
  /** Set when the customer changed it themselves, through their link: their address. */
  byCustomer?: true;
}

export interface DraftOrderDeletedPayload {
  number: number;
}

/** A draft became an order. */
export interface DraftOrderCompletedPayload extends DraftOrderState {
  orderId: string;
  /** Whether the customer confirmed it through its link, rather than staff or an app placing it. */
  confirmedByCustomer: boolean;
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

/** The shop changed when risky orders wait for review. The aggregate is the shop. */
export interface RiskSettingsUpdatedPayload {
  /** 1 to 100, or null to hold none. */
  holdAt: number | null;
  /** Minor units, as a string. */
  highValue: string;
  currency: string;
  /** Who changed it. */
  actorKind: 'app' | 'staff';
  actorId: string;
}

export interface OrderSettingsUpdatedPayload {
  customerCancellation: CustomerCancellationValue;
  /** Who changed them. */
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * The shop's bank account for transfers changed, or was turned on or off: what changed, not the
 * account, which staff read through the API.
 */
export interface BankTransferSettingsUpdatedPayload {
  enabled: boolean;
  /**
   * "enabled", "account" (title, bank or IBAN), "instructions" and "discount" (what paying by
   * transfer takes off): those that changed.
   */
  changed: string[];
  /** Who changed them. */
  actorKind: 'app' | 'staff';
  actorId: string;
}

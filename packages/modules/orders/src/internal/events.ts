import type {
  CancelReasonValue,
  CustomerCancellationValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  FulfillmentEventStatusValue,
  OrderSourceValue,
  OrderStageValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  ReturnStatusValue,
  RiskLevelValue,
} from './schema.js';

/**
 * Events the orders module publishes. Payloads are thin: fetch current state through the API.
 * Every order event carries the order's stage and version after the change, so consumers can keep
 * counts per stage and drop stale updates. A parcel's events (`fulfillment.*`) and a return's
 * (`return.*`) carry their order's.
 */
export const OrderEvents = {
  OrderCreated: 'order.created',
  OrderUpdated: 'order.updated',
  OrderConfirmed: 'order.confirmed',
  OrderCancelled: 'order.cancelled',
  OrderPaid: 'order.paid',
  OrderRefunded: 'order.refunded',
  OrderReceiptsErased: 'order.receipts_erased',
  OrderExportCreated: 'order_export.created',
  DraftOrderCreated: 'draft_order.created',
  DraftOrderUpdated: 'draft_order.updated',
  DraftOrderDeleted: 'draft_order.deleted',
  DraftOrderCompleted: 'draft_order.completed',
  FulfillmentCreated: 'fulfillment.created',
  FulfillmentUpdated: 'fulfillment.updated',
  FulfillmentEventCreated: 'fulfillment_event.created',
  ReturnCreated: 'return.created',
  ReturnClosed: 'return.closed',
  ReturnCancelled: 'return.cancelled',
  RiskSettingsUpdated: 'order_risk_settings.updated',
  OrderSettingsUpdated: 'order_settings.updated',
  SavedSearchCreated: 'saved_search.created',
  SavedSearchUpdated: 'saved_search.updated',
  SavedSearchDeleted: 'saved_search.deleted',
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
  /**
   * The order it was split from (ADR-135), for a part of an order its customer placed once:
   * nothing new was placed.
   */
  splitFromId?: string;
}

export interface OrderUpdatedPayload extends OrderState {
  /**
   * Names of what changed, e.g. "shippingAddress", "note", "tags"; "customer" with a new number,
   * "packed" when marked packed or not, "link" when a link was made for the customer, "risk" when
   * scored again as the customer's history changed (ADR-112).
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

/**
 * The receipts the customer sent for the order's transfer went with their erasure (ADR-113):
 * where storage keeps their files, for the worker to remove them.
 */
export interface OrderReceiptsErasedPayload {
  keys: string[];
}

export interface OrderRefundedPayload extends OrderState {
  refundId: string;
  /** Minor units, as strings: this refund, and all the order's refunds so far. */
  amount: string;
  amountRefunded: string;
  /** What of this refund was sales tax, in minor units (ADR-105). */
  tax: string;
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

/**
 * A step of a parcel's way was recorded (ADR-160): what its courier said, or staff recorded. The
 * aggregate is the step.
 */
export interface FulfillmentEventCreatedPayload {
  orderId: string;
  fulfillmentId: string;
  status: FulfillmentEventStatusValue;
  orderStage: OrderStageValue;
  orderVersion: number;
}

/** A customer return was recorded, checked in or cancelled (ADR-136). The aggregate is it. */
export interface ReturnPayload {
  orderId: string;
  /** The order's first return is 1, named #1001-R1. */
  number: number;
  status: ReturnStatusValue;
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
  /** The Confirmation Desk's calling hours, as clocks: "10:00"; null for any time. */
  callingHours: { opens: string; closes: string } | null;
  firstCallMinutes: number | null;
  cancelUnreachableAfterDays: number | null;
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

/** A saved search of one of the shop's lists (ADR-119, ADR-124): who keeps it is the shop. */
export interface SavedSearchCreatedPayload {
  /** The list it searches: "order", "draft_order" or "product". */
  resourceType: string;
  version: number;
}

export interface SavedSearchUpdatedPayload {
  /** "name", "query". */
  changed: string[];
  version: number;
}

export type SavedSearchDeletedPayload = Record<string, never>;

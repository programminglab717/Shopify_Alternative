import type { CurrencyCode } from '@hatti/money';
import type {
  ActorKind,
  AddressValue,
  CancelReasonValue,
  ConfirmationStatusValue,
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RiskLevelValue,
  RiskReasonValue,
} from './schema.js';

/** A line of an order: what was sold, as it was then. */
export interface OrderLineRecord {
  id: string;
  position: number;
  /** The variant sold. It may have been deleted since. */
  variantId: string;
  productId: string;
  /** The product's title when it was sold. */
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** Minor units in the order's currency. */
  unitPrice: bigint;
  total: bigint;
  weightGrams: number | null;
  /** Units shipped so far. */
  fulfilledQuantity: number;
}

/** A parcel: what shipped together, with which courier, and what became of it. */
export interface FulfillmentRecord {
  id: string;
  status: ParcelStatusValue;
  /** Where it shipped from. */
  locationId: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  lines: {
    lineId: string;
    quantity: number;
    /** Once back: how many went back on the shelf; the rest were written off. */
    restockedQuantity: number | null;
  }[];
  shippedAt: Date;
  deliveredAt: Date | null;
  returningAt: Date | null;
  returnedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How likely a cash-on-delivery order is to come back unpaid, as scored when it was placed or its
 * address last changed.
 */
export interface OrderRiskRecord {
  /** 0 to 100. */
  score: number;
  level: RiskLevelValue;
  /** Strongest first. */
  reasons: RiskReasonValue[];
}

export interface OrderRecord {
  id: string;
  /** #1001 onwards, per shop. */
  number: number;
  source: OrderSourceValue;
  status: OrderStatusValue;
  confirmationStatus: ConfirmationStatusValue;
  financialStatus: FinancialStatusValue;
  fulfillmentStatus: FulfillmentStatusValue;
  stage: OrderStageValue;
  paymentMethod: PaymentMethodValue;
  currency: CurrencyCode;
  /** Minor units. total = subtotal − discount + shipping. */
  subtotal: bigint;
  discount: bigint;
  shipping: bigint;
  total: bigint;
  amountPaid: bigint;
  /** What the courier collects at the door. */
  codAmount: bigint;
  /** The customer with the order's mobile number. */
  customerId: string;
  phone: string;
  email: string | null;
  shippingAddress: AddressValue;
  /** Where its stock was committed and where it ships from. */
  locationId: string;
  note: string;
  tags: string[];
  cancelReason: CancelReasonValue | null;
  /** Cash-on-delivery orders only. */
  risk: OrderRiskRecord | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lines: OrderLineRecord[];
  /** Parcels, oldest first. */
  fulfillments: FulfillmentRecord[];
}

/** An entry of an order's timeline. */
export interface OrderEventRecord {
  id: string;
  orderId: string;
  kind: string;
  message: string;
  actorKind: ActorKind;
  actorId: string | null;
  createdAt: Date;
}

/**
 * What a customer's orders add up to, worked out from the orders when asked for: stored nowhere,
 * so never out of step with them.
 */
export interface CustomerOrderStats {
  /** Orders placed, cancelled ones included. */
  count: number;
  /** What they paid on their orders, cancelled ones aside; minor units in the shop's currency. */
  amountSpent: bigint;
  /** Delivered, paid for or not. */
  delivered: number;
  /** Refused or undeliverable: coming back, or back. */
  returned: number;
  /** Cancelled before shipping. */
  cancelled: number;
  /** The rest: to confirm, review or ship, or on the way to the customer. */
  inProgress: number;
  lastOrderAt: Date | null;
}

/** Before a customer's first order. */
export const NO_ORDERS: CustomerOrderStats = {
  count: 0,
  amountSpent: 0n,
  delivered: 0,
  returned: 0,
  cancelled: 0,
  inProgress: 0,
  lastOrderAt: null,
};

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

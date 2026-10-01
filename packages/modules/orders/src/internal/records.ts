import type { CurrencyCode } from '@hatti/money';
import type {
  ActorKind,
  AddressValue,
  CancelReasonValue,
  ConfirmationStatusValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  RiskLevelValue,
  RiskReasonValue,
  StoredAddressValue,
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
    /** Once back, or lost: how many went back on the shelf; the rest were written off. */
    restockedQuantity: number | null;
  }[];
  shippedAt: Date;
  deliveredAt: Date | null;
  returningAt: Date | null;
  returnedAt: Date | null;
  /** When it was marked lost by its courier; kept if it turns up and is checked back in. */
  lostAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Money given back on an order, as staff recorded it. */
export interface RefundRecord {
  id: string;
  /** Minor units in the order's currency. */
  amount: bigint;
  method: RefundMethodValue;
  /** The transfer's reference, such as a wallet transaction ID; null once erased. */
  reference: string | null;
  note: string;
  actorKind: 'app' | 'staff';
  actorId: string;
  createdAt: Date;
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

export interface OrderLinkRecord {
  /**
   * When it stops working: at its own expiry, or 30 days after the order ends. Null while the
   * order is open, for a link that lasts.
   */
  expiresAt: Date | null;
}

/** An order's e-contract log (ADR-057). */
export interface OrderAgreementRecord {
  /** The versions of the shop's policies its checkout linked; none when it had none. */
  policyVersions: string[];
  /** Where it was placed from, as the customer's browser told it; null once their data is erased. */
  ip: string | null;
  userAgent: string | null;
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
  /** The discount codes it was placed with, as the shop wrote them. */
  discountCodes: string[];
  amountPaid: bigint;
  /** Given back since, in refunds; never more than was paid. */
  amountRefunded: bigint;
  /** What the courier collects at the door. */
  codAmount: bigint;
  /**
   * The customer with the order's mobile number. Once that customer's data is erased, a
   * customer that no longer exists.
   */
  customerId: string;
  /** Null once the customer's data is erased. */
  phone: string | null;
  email: string | null;
  shippingAddress: StoredAddressValue;
  /** When the customer's data was erased, at their request. */
  customerErasedAt: Date | null;
  /** Where its stock was committed and where it ships from. */
  locationId: string;
  note: string;
  tags: string[];
  cancelReason: CancelReasonValue | null;
  /** Cash-on-delivery orders only. */
  risk: OrderRiskRecord | null;
  /** The customer's link, if one was made and not taken away. */
  link: OrderLinkRecord | null;
  /**
   * What its customer agreed to in placing it through checkout, and when: when it was placed
   * (ADR-057). Null for orders staff and apps place.
   */
  agreement: OrderAgreementRecord | null;
  confirmedAt: Date | null;
  /** When it was marked packed, ready to hand to a courier; null while it is not. */
  packedAt: Date | null;
  cancelledAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lines: OrderLineRecord[];
  /** Parcels, oldest first. */
  fulfillments: FulfillmentRecord[];
  /** Oldest first. */
  refunds: RefundRecord[];
}

/** A draft order's line: the item at the price agreed, as it was when added. */
export interface DraftOrderLineRecord {
  /** The variant to sell. It may have been deleted since. */
  variantId: string;
  productId: string;
  /** The product's title when it was added. */
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** Minor units in the draft's currency. */
  unitPrice: bigint;
  total: bigint;
}

/** An order taken in a chat before it is placed. */
export interface DraftOrderRecord {
  id: string;
  /** #D1 onwards, per shop. */
  number: number;
  status: DraftOrderStatusValue;
  source: DraftOrderSourceValue;
  paymentMethod: PaymentMethodValue;
  currency: CurrencyCode;
  lines: DraftOrderLineRecord[];
  /** Minor units. total = subtotal − discount + shipping. */
  subtotal: bigint;
  discount: bigint;
  shipping: bigint;
  total: bigint;
  /** Paid in advance on a cash-on-delivery order. */
  advancePaid: bigint;
  /** What the courier will collect at the door. */
  codAmount: bigint;
  /** The customer's number and address, once they send them; both or neither. */
  phone: string | null;
  email: string | null;
  shippingAddress: AddressValue | null;
  /** Where the order will ship from; the primary location when it is placed, if null. */
  locationId: string | null;
  note: string;
  tags: string[];
  /** The order it became, once completed. */
  orderId: string | null;
  /** When the customer's link stops working; null without a link. */
  linkExpiresAt: Date | null;
  /** Who started it: the access token or the staff member. */
  actorKind: 'app' | 'staff';
  actorId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
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

/** How many orders, and what they come to: minor units in the shop's currency. */
export interface OrderTally {
  count: number;
  total: bigint;
}

/** What waits for the shop, as the admin's home shows it first (ANL-01). */
export interface OrderHome {
  /** Cash-on-delivery orders waiting for their customers to confirm them. */
  toConfirm: OrderTally;
  /** Held for staff: a blocked number or a risk score at the shop's threshold. */
  toReview: OrderTally;
  toPack: OrderTally;
  /** Packed, for a courier to take. */
  toBook: OrderTally;
  /** Parcels on their way back, to check in. */
  returning: OrderTally;
  /**
   * Cash on delivery not yet received: on parcels on their way, and on delivered orders not yet
   * marked paid. `total` is the cash, not the orders' totals.
   */
  cashToCollect: OrderTally;
}

/**
 * What a customer's orders add up to, worked out from the orders when asked for: stored nowhere,
 * so never out of step with them.
 */
export interface CustomerOrderStats {
  /** Orders placed, cancelled ones included. */
  count: number;
  /**
   * What they paid on their orders, cancelled ones aside, less refunds; minor units in the shop's
   * currency.
   */
  amountSpent: bigint;
  /** Delivered, paid for or not. */
  delivered: number;
  /** Refused or undeliverable: coming back, or back. */
  returned: number;
  /** Lost by the courier before reaching them: not their doing. */
  lost: number;
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
  lost: 0,
  cancelled: 0,
  inProgress: 0,
  lastOrderAt: null,
};

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

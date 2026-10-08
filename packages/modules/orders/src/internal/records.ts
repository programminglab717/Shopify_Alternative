import type { CurrencyCode } from '@hatti/money';
import type { UtmValue } from './attribution.js';
import type {
  ActorKind,
  AddressValue,
  BankAccountValue,
  CancelReasonValue,
  ConfirmationStatusValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  FinancialStatusValue,
  FulfillmentEventStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelClaimStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
  RefundMethodValue,
  ReturnReasonValue,
  ReturnStatusValue,
  RiskLevelValue,
  RiskReasonValue,
  SavedSearchTypeValue,
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
  /** Whether its variant's price included the shop's sales tax when it was sold (ADR-096). */
  taxable: boolean;
  /** The rate it was taxed at, in hundredths of a percent; null when it was not. */
  taxRate: number | null;
  /** What of its total, after its share of the order's discount, was tax. */
  tax: bigint;
}

/**
 * A shop's claim on a courier for a parcel it lost (ADR-093), followed until the courier pays it,
 * in a statement or otherwise, or refuses it, or the shop withdraws it. Amounts are minor units.
 */
export interface ParcelClaimRecord {
  status: ParcelClaimStatusValue;
  /** What the shop claims: the parcel's worth unless it said otherwise. */
  amount: bigint;
  /** What the courier paid on it, once paid. */
  paid: bigint | null;
  /** The shop's own words: the courier's claim number, or why it was refused. */
  note: string | null;
  claimedAt: Date;
  /** When it was paid, refused or withdrawn; null while open. */
  settledAt: Date | null;
}

/** A step of a parcel's way to its customer (ADR-160). */
export interface FulfillmentEventRecord {
  id: string;
  fulfillmentId: string;
  status: FulfillmentEventStatusValue;
  /** The courier's words, or the shop's own; none once the customer's data was erased. */
  message: string | null;
  happenedAt: Date;
  createdAt: Date;
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
  /**
   * Minor units: what couriers' statements charged for it, both ways, as they were imported
   * (COD-10, ADR-088); null while none has.
   */
  courierCharges: bigint | null;
  /** Its claim on the courier that lost it; null while it has none. */
  claim: ParcelClaimRecord | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Money given back on an order, as staff recorded it. */
export interface RefundRecord {
  id: string;
  /** Minor units in the order's currency. */
  amount: bigint;
  /**
   * What of it was sales tax (ADR-105): the order's tax in what has been refunded so far, less
   * what the refunds before it gave back.
   */
  tax: bigint;
  method: RefundMethodValue;
  /** The transfer's reference, such as a wallet transaction ID; null once erased. */
  reference: string | null;
  note: string;
  /** The receipt staff kept of the money they sent (ADR-242); null without one, or once erased. */
  receipt: RefundReceiptRecord | null;
  actorKind: 'app' | 'staff';
  actorId: string;
  createdAt: Date;
}

/** A refund's receipt, among its order's receipts in storage (ADR-242). */
export interface RefundReceiptRecord {
  /** Where storage keeps it. */
  key: string;
  /** image/jpeg, image/png, image/webp or application/pdf. */
  contentType: string;
  /** Bytes. */
  size: number;
}

/** A customer sending back items of a delivered parcel (ORD-07, ADR-136). */
export interface ReturnRecord {
  id: string;
  orderId: string;
  /** The order's first return is 1, named #1001-R1. */
  number: number;
  status: ReturnStatusValue;
  /** Where its items come back to, and go back in stock. */
  locationId: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
  note: string;
  /** The order sent in exchange (ADR-137), by its ID and number. */
  exchangeOrder: { orderId: string; number: number } | null;
  lines: {
    lineId: string;
    quantity: number;
    reason: ReturnReasonValue;
    /** Once checked in: how many went back in stock; the rest were written off. */
    restockedQuantity: number | null;
  }[];
  actorKind: 'app' | 'staff';
  actorId: string;
  createdAt: Date;
  closedAt: Date | null;
  cancelledAt: Date | null;
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
  /**
   * The versions of the shop's policies its checkout, or the link it or its draft was confirmed
   * through (ADR-114, ADR-115), linked; none when it had none.
   */
  policyVersions: string[];
  /** When: when the order was placed, or when its customer confirmed it through its link. */
  agreedAt: Date;
  /** Where it was placed from, as the customer's browser told it; null once their data is erased. */
  ip: string | null;
  userAgent: string | null;
}

/** A visit to the online store that led to an order (ADR-139). */
export interface OrderVisitRecord {
  occurredAt: Date;
  /**
   * Where it came from: its link's `utm_source`; else the platform of its ad or of the site
   * linking to it, or that site's domain; else "direct".
   */
  source: string;
  /** Its landing page's UTM parameters; null where it had none. */
  utm: UtmValue | null;
  /** The address it began at, its query with it; null once the customer's data is erased. */
  landingPage: string | null;
  /**
   * The page on another site that linked to it, without its query; null when the browser said
   * none, and once the customer's data is erased.
   */
  referrerUrl: string | null;
}

/** Where an order's customer came to the online store from before placing it (ORD-13, ADR-139). */
export interface OrderAttributionRecord {
  orderId: string;
  firstVisit: OrderVisitRecord;
  /** The last visit from elsewhere before it: the first, when there was one. */
  lastVisit: OrderVisitRecord;
  /** Whole days from the first visit to when the order was placed. */
  daysToConversion: number;
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
  /** Minor units. total = subtotal − discount + shipping + codFee. */
  subtotal: bigint;
  discount: bigint;
  shipping: bigint;
  /** What it charges for paying on delivery (CHK-08): checkout's, when the shop charges one. */
  codFee: bigint;
  /**
   * The shop's sales tax when it was placed (ADR-096), in hundredths of a percent; null when it
   * charged none. Prices include it.
   */
  taxRate: number | null;
  /** The tax included in its total: its lines' and its charges'. */
  totalTax: bigint;
  /** Of `totalTax`, what was in its delivery charge and its fee for paying on delivery. */
  shippingTax: bigint;
  /**
   * Of `discount`, what checkout took off for paying by bank transfer (CHK-08, ADR-077); the rest
   * is the codes' or staff's.
   */
  transferDiscount: bigint;
  /** Of `discount`, what checkout took off for paying online (PAY-05, ADR-222). */
  onlineDiscount: bigint;
  total: bigint;
  /** The discount codes it was placed with, as the shop wrote them. */
  discountCodes: string[];
  amountPaid: bigint;
  /** Given back since, in refunds; never more than was paid. */
  amountRefunded: bigint;
  /** What the courier collects at the door. */
  codAmount: bigint;
  /**
   * What a cash-on-delivery order asks for in advance, by transfer, before it ships (ADR-083);
   * zero for none. Received, it counts in `amountPaid`.
   */
  advanceDue: bigint;
  /**
   * The account a bank-transfer order's customer was told to pay into, as it was when it was
   * placed (ADR-074), or a cash-on-delivery order's for its advance; null for other orders, and
   * when the shop had none.
   */
  bankAccount: BankAccountValue | null;
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
  /**
   * When it came in past the orders its shop's plan allows in a month (ADR-263): staff see its
   * customer hidden, and cannot confirm, pack, book or ship it, until the plan has room for it.
   */
  overLimitAt: Date | null;
  /** Where its stock was committed and where it ships from. */
  locationId: string;
  note: string;
  tags: string[];
  cancelReason: CancelReasonValue | null;
  /** The order it was merged into, cancelled as `merged` (ADR-132), by its ID and number. */
  mergedInto: { orderId: string; number: number } | null;
  /** The order it was split from (ADR-135), the first one, by its ID and number. */
  splitFrom: { orderId: string; number: number } | null;
  /** Cash-on-delivery orders only. */
  risk: OrderRiskRecord | null;
  /** The customer's link, if one was made and not taken away. */
  link: OrderLinkRecord | null;
  /**
   * What its customer agreed to in placing it through checkout, or confirming it, or its draft,
   * through a link, and when (ADR-057, ADR-114, ADR-115). Null for orders staff and apps place,
   * until their customers confirm them through their links.
   */
  agreement: OrderAgreementRecord | null;
  confirmedAt: Date | null;
  /** When it was marked packed, ready to hand to a courier; null while it is not. */
  packedAt: Date | null;
  cancelledAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  /**
   * The member of staff it is given to, to see through (ORD-10, ADR-127), and since when; null
   * while no one has it.
   */
  assignee: { staffMemberId: string; assignedAt: Date } | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lines: OrderLineRecord[];
  /** Parcels, oldest first. */
  fulfillments: FulfillmentRecord[];
  /** Oldest first. */
  refunds: RefundRecord[];
  /** Its customer's returns (ADR-136), the first first. */
  returns: ReturnRecord[];
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
  /**
   * Asked for in advance on a cash-on-delivery order, by transfer, not beside `advancePaid`: the
   * order its customer confirms waits for it (ADR-085).
   */
  advanceDue: bigint;
  /** What the courier will collect at the door: what the advance, paid or asked for, leaves. */
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
/**
 * An entry of an order's timeline: something that happened to it, or a comment staff or an app
 * wrote on it (`comment`, ADR-128), whose author is its actor.
 */
export interface OrderEventRecord {
  id: string;
  orderId: string;
  kind: string;
  message: string;
  actorKind: ActorKind;
  actorId: string | null;
  createdAt: Date;
  /** Whether it is a comment, which its author may change, rather than something that happened. */
  comment: boolean;
  /** When a comment's author last changed it; null for events and comments as written. */
  editedAt: Date | null;
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
  /** Bank-transfer orders whose money staff have not seen yet. */
  awaitingPayment: OrderTally;
  /**
   * Of those, the orders whose customers sent a receipt for their transfer (ADR-080): to check
   * against the shop's account first.
   */
  transfersToCheck: OrderTally;
  toPack: OrderTally;
  /** Packed, for a courier to take. */
  toBook: OrderTally;
  /** Parcels on their way back, to check in. */
  returning: OrderTally;
  /**
   * Customer returns on their way (ADR-138), to check in: `total` is what their items sold for.
   */
  returnsToReceive: OrderTally;
  /**
   * Parcels the courier lost that the shop has not claimed yet (ADR-093). `count` is parcels and
   * `total` their worth.
   */
  lostToClaim: OrderTally;
  /** Claims on couriers they have neither paid nor refused yet: parcels, and what is claimed. */
  claimsOpen: OrderTally;
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

/** A search of one of its lists the shop keeps by name (ADR-119, ADR-124). */
export interface SavedSearchRecord {
  id: string;
  /** The list it searches. */
  resourceType: SavedSearchTypeValue;
  name: string;
  /** As its list's search takes it: orders(query:), draftOrders(query:) or products(query:). */
  query: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

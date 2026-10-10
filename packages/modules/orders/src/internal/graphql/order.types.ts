import { Money, PageInfo, UserError } from '@hatti/api';
import { TaxLine } from '@hatti/tax/public';
import { BankAccount } from './bank-transfer.types.js';
import { RefundReceipt } from './transfer-receipt.types.js';
import {
  ArgsType,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum OrderStage {
  NEEDS_CONFIRMATION = 'NEEDS_CONFIRMATION',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  TO_PACK = 'TO_PACK',
  TO_BOOK = 'TO_BOOK',
  PARTIALLY_FULFILLED = 'PARTIALLY_FULFILLED',
  IN_TRANSIT = 'IN_TRANSIT',
  RETURNING = 'RETURNING',
  DELIVERED = 'DELIVERED',
  RETURNED = 'RETURNED',
  LOST = 'LOST',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(OrderStage, {
  name: 'OrderStage',
  description: 'Where an order is, as one state: the tabs of the order list.',
  valuesMap: {
    NEEDS_CONFIRMATION: { description: 'Cash on delivery, waiting for the customer to confirm.' },
    NEEDS_REVIEW: { description: 'Held for staff to check, e.g. a risky or duplicate order.' },
    AWAITING_PAYMENT: {
      description:
        'Paid by bank transfer: waiting for the money, until staff see it and mark the order paid.',
    },
    TO_PACK: { description: 'Confirmed or paid; to pick and pack.' },
    TO_BOOK: { description: 'Packed; to book with a courier and hand over.' },
    PARTIALLY_FULFILLED: { description: 'Some items shipped, some still to ship.' },
    IN_TRANSIT: { description: 'Everything shipped; on its way.' },
    RETURNING: { description: 'Refused or undeliverable; on its way back.' },
    DELIVERED: { description: 'Delivered; waiting for the cash to be collected or remitted.' },
    RETURNED: { description: 'Came back and was checked in.' },
    LOST: { description: 'Lost by the courier, on its way out or back: written off.' },
    COMPLETED: { description: 'Delivered and paid.' },
    CANCELLED: { description: 'Cancelled before it shipped.' },
  },
});

export enum OrderStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(OrderStatus, { name: 'OrderStatus' });

export enum OrderConfirmationStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
  NO_RESPONSE = 'NO_RESPONSE',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

registerEnumType(OrderConfirmationStatus, {
  name: 'OrderConfirmationStatus',
  description: 'Whether the customer confirmed a cash-on-delivery order. Prepaid orders need not.',
});

export enum OrderFinancialStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  PAID = 'PAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  VOIDED = 'VOIDED',
}

registerEnumType(OrderFinancialStatus, {
  name: 'OrderFinancialStatus',
  description: 'PENDING: cash is due on delivery, or a payment has not arrived.',
});

export enum OrderFulfillmentStatus {
  UNFULFILLED = 'UNFULFILLED',
  PARTIALLY_FULFILLED = 'PARTIALLY_FULFILLED',
  FULFILLED = 'FULFILLED',
  RETURNED = 'RETURNED',
  PARTIALLY_RETURNED = 'PARTIALLY_RETURNED',
}

registerEnumType(OrderFulfillmentStatus, { name: 'OrderFulfillmentStatus' });

export enum RefundMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  MOBILE_WALLET = 'MOBILE_WALLET',
  CASH = 'CASH',
  OTHER = 'OTHER',
  EXCHANGE = 'EXCHANGE',
  ONLINE = 'ONLINE',
  STORE_CREDIT = 'STORE_CREDIT',
}

registerEnumType(RefundMethod, {
  name: 'RefundMethod',
  description:
    'How a refund went back to the customer. Staff send the money and Hatti records it; but ' +
    'ONLINE, which Hatti asks the payment gateway to send.',
  valuesMap: {
    BANK_TRANSFER: { description: 'To a bank account, such as by IBFT or Raast.' },
    MOBILE_WALLET: { description: 'To a JazzCash or Easypaisa wallet.' },
    CASH: { description: 'In cash.' },
    OTHER: { description: 'Another way; the note says which.' },
    EXCHANGE: {
      description:
        'No money moved: what was paid for items coming back went to the exchange a return sent ' +
        '(ADR-137), whose order the reference names. Made by returnCreate, never by orderRefund.',
    },
    ONLINE: {
      description:
        "Back through the payment gateway the customer paid with online, on the order's latest " +
        'payment that can take it (ADR-153): Hatti asks the gateway, and records the refund once ' +
        "the gateway says it is sent, with the gateway's reference. Only through gateways whose " +
        'PaymentGateway.refunds is not NONE; WHOLE ones give a payment back whole.',
    },
    STORE_CREDIT: {
      description:
        "No money moved: the customer's store credit account was credited with it, to spend on " +
        "later orders (ADR-184), the credit's transaction ID its reference. Needs the " +
        'write_store_credit_account_transactions scope too.',
    },
  },
});

@ObjectType({ description: 'Money given back on an order, as staff recorded it.' })
export class Refund {
  @Field(() => ID)
  id!: string;

  @Field(() => Money)
  amount!: Money;

  @Field(() => Money, {
    description:
      "What of it was sales tax: the order's tax in all it has refunded, in proportion to its " +
      'total, less what the refunds before it gave back. Refunds of a whole order give back all ' +
      'its tax.',
  })
  totalTax!: Money;

  @Field(() => RefundMethod)
  method!: RefundMethod;

  @Field(() => String, {
    nullable: true,
    description:
      "The transfer's reference, such as a wallet transaction ID. Cleared, with the note, when " +
      "the customer's data is erased.",
  })
  reference!: string | null;

  @Field({ description: "Why, for the shop's records." })
  note!: string;

  @Field(() => RefundReceipt, {
    nullable: true,
    description:
      'The receipt staff kept of the money they sent (ADR-242); null without one, and once the ' +
      "customer's data is erased.",
  })
  receipt!: RefundReceipt | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

export enum OrderPaymentMethod {
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  PREPAID = 'PREPAID',
  BANK_TRANSFER = 'BANK_TRANSFER',
  ONLINE = 'ONLINE',
}

registerEnumType(OrderPaymentMethod, {
  name: 'OrderPaymentMethod',
  valuesMap: {
    CASH_ON_DELIVERY: { description: 'The courier collects the cash at the door.' },
    PREPAID: {
      description: 'Paid in full when placed, e.g. by a transfer or wallet payment already seen.',
    },
    BANK_TRANSFER: {
      description:
        "The customer pays into the shop's bank account after placing it: it waits at " +
        'AWAITING_PAYMENT until staff see the money and mark it paid, and needs no confirming.',
    },
    ONLINE: {
      description:
        "The customer pays online through the shop's payment gateway after placing it, from " +
        'its page: it waits at AWAITING_PAYMENT until the gateway says it is paid, and needs no ' +
        'confirming. Only where the shop has a payment gateway account; never a draft.',
    },
  },
});

export enum OrderSource {
  ONLINE_STORE = 'ONLINE_STORE',
  WHATSAPP = 'WHATSAPP',
  INSTAGRAM = 'INSTAGRAM',
  FACEBOOK = 'FACEBOOK',
  POS = 'POS',
  MANUAL = 'MANUAL',
  API = 'API',
  MARKETPLACE = 'MARKETPLACE',
  RESELLER = 'RESELLER',
}

registerEnumType(OrderSource, {
  name: 'OrderSource',
  valuesMap: {
    ONLINE_STORE: { description: "Placed by a shopper through the online store's checkout." },
    WHATSAPP: { description: 'From a WhatsApp chat, through a draft order.' },
    INSTAGRAM: { description: 'From an Instagram chat, through a draft order.' },
    FACEBOOK: { description: 'From a Facebook chat, through a draft order.' },
    POS: { description: 'Sold at the point of sale. Reserved: no orders come from it yet.' },
    MANUAL: { description: 'Entered by staff, e.g. taken on a call or in a chat.' },
    API: { description: 'Sent by an app.' },
    MARKETPLACE: {
      description: 'From a marketplace, such as Daraz. Reserved: no orders come from it yet.',
    },
    RESELLER: { description: 'Placed by a reseller. Reserved: no orders come from it yet.' },
  },
});

export enum OrderCancelReason {
  CUSTOMER = 'CUSTOMER',
  NO_RESPONSE = 'NO_RESPONSE',
  FRAUD = 'FRAUD',
  INVENTORY = 'INVENTORY',
  OTHER = 'OTHER',
  MERGED = 'MERGED',
  UNPAID = 'UNPAID',
}

registerEnumType(OrderCancelReason, {
  name: 'OrderCancelReason',
  valuesMap: {
    CUSTOMER: { description: 'The customer cancelled.' },
    NO_RESPONSE: { description: 'The customer could not be reached to confirm.' },
    FRAUD: { description: 'A fake or fraudulent order.' },
    INVENTORY: { description: 'Out of stock.' },
    OTHER: {},
    MERGED: {
      description:
        "Merged into another of its customer's orders, which took its items; orderMerge alone " +
        'cancels an order so, and `mergedInto` names the order.',
    },
    UNPAID: {
      description:
        'Not paid, by transfer, online or its advance, in the days the shop allows (ADR-168).',
    },
  },
});

export enum FulfillmentStatus {
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  RETURNING = 'RETURNING',
  RETURNED = 'RETURNED',
  LOST = 'LOST',
}

registerEnumType(FulfillmentStatus, {
  name: 'FulfillmentStatus',
  description: 'Where a parcel is.',
  valuesMap: {
    IN_TRANSIT: { description: 'Shipped; on its way to the customer.' },
    DELIVERED: { description: 'Delivered to the customer.' },
    RETURNING: { description: 'Refused or undeliverable; on its way back (return to origin).' },
    RETURNED: { description: 'Back, and checked in: its items restocked or written off.' },
    LOST: {
      description:
        'Lost by the courier, on its way out or back: its items written off. Checked back in ' +
        'if it turns up.',
    },
  },
});

export enum FulfillmentEventStatus {
  CONFIRMED = 'CONFIRMED',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  ATTEMPTED_DELIVERY = 'ATTEMPTED_DELIVERY',
  DELIVERED = 'DELIVERED',
  RETURNING = 'RETURNING',
  RETURNED = 'RETURNED',
  FAILURE = 'FAILURE',
}

registerEnumType(FulfillmentEventStatus, {
  name: 'FulfillmentEventStatus',
  description:
    "A step of a parcel's way to its customer, as Shopify's are named; RETURNING and RETURNED are " +
    "Hatti's own (ADR-160).",
  valuesMap: {
    CONFIRMED: { description: 'Its courier booked it.' },
    IN_TRANSIT: { description: 'On its way: picked up, at a warehouse, or between cities.' },
    OUT_FOR_DELIVERY: { description: 'With the rider, to be delivered today.' },
    ATTEMPTED_DELIVERY: { description: 'The rider tried to deliver it, and could not.' },
    DELIVERED: { description: 'Delivered, as its courier said.' },
    RETURNING: { description: 'Refused or undeliverable: on its way back to the shop.' },
    RETURNED: { description: 'Back with the shop, as its courier said.' },
    FAILURE: { description: 'Its courier lost it, or gave up its booking.' },
  },
});

export enum FulfillmentClaimStatus {
  OPEN = 'OPEN',
  PAID = 'PAID',
  REFUSED = 'REFUSED',
  WITHDRAWN = 'WITHDRAWN',
}

registerEnumType(FulfillmentClaimStatus, {
  name: 'FulfillmentClaimStatus',
  description: 'What became of a claim on the courier that lost a parcel.',
  valuesMap: {
    OPEN: { description: 'Filed; the courier has neither paid nor refused it yet.' },
    PAID: { description: 'The courier paid on it, in a statement or otherwise.' },
    REFUSED: { description: 'The courier refused it. It may still be paid, or withdrawn.' },
    WITHDRAWN: {
      description: 'The shop withdrew it; so is it when the parcel turns up and is checked in.',
    },
  },
});

export enum FulfillmentClaimSettlement {
  PAID = 'PAID',
  REFUSED = 'REFUSED',
  WITHDRAWN = 'WITHDRAWN',
}

registerEnumType(FulfillmentClaimSettlement, {
  name: 'FulfillmentClaimSettlement',
  description: 'What became of a claim, as the shop records it.',
  valuesMap: {
    PAID: { description: 'The courier paid it otherwise than in a statement: give the amount.' },
    REFUSED: { description: 'The courier refused it: say why in the note.' },
    WITHDRAWN: { description: 'The shop gives it up.' },
  },
});

export enum LostParcelClaimFilter {
  UNCLAIMED = 'UNCLAIMED',
  OPEN = 'OPEN',
  PAID = 'PAID',
  REFUSED = 'REFUSED',
  WITHDRAWN = 'WITHDRAWN',
}

registerEnumType(LostParcelClaimFilter, {
  name: 'LostParcelClaimFilter',
  description: 'Which lost parcels to list: those not claimed yet, or with claims in a state.',
  valuesMap: {
    UNCLAIMED: { description: 'Not claimed from the courier yet.' },
  },
});

export enum OrderRiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

registerEnumType(OrderRiskLevel, {
  name: 'OrderRiskLevel',
  description: 'How likely a cash-on-delivery order is to come back unpaid.',
  valuesMap: {
    LOW: { description: 'A score under 0.3.' },
    MEDIUM: { description: 'A score from 0.3 to under 0.6.' },
    HIGH: { description: 'A score of 0.6 or more.' },
  },
});

@ObjectType({ description: 'Why an order scored what it did.' })
export class OrderRiskReason {
  @Field({
    description: 'e.g. "refused_deliveries", "recent_order", "high_value", "unknown_city".',
  })
  code!: string;

  @Field({ description: 'e.g. "Refused 2 deliveries from this shop".' })
  message!: string;

  @Field(() => Float, {
    description: 'What it adds to the score, from -1 to 1; a negative weight lowers it.',
  })
  weight!: number;
}

@ObjectType({
  description:
    'How likely a cash-on-delivery order is to come back unpaid, from transparent rules: the ' +
    "customer's history in this shop, the order's value and size, and its address. Scored when " +
    'the order is placed and when its address changes.',
})
export class OrderRisk {
  @Field(() => Float, { description: '0 to 1.' })
  score!: number;

  @Field(() => OrderRiskLevel)
  level!: OrderRiskLevel;

  @Field(() => [OrderRiskReason], { description: 'Strongest first.' })
  reasons!: OrderRiskReason[];
}

@ObjectType({
  description:
    "A delivery address in Pakistan. Once the customer's details are erased, only the city and " +
    'province are left.',
})
export class MailingAddress {
  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Mobile number in E.164 form; masked like Order.phone.',
  })
  phone!: string | null;

  @Field(() => String, { nullable: true, description: 'The house and street.' })
  address1!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The area, such as Gulshan-e-Iqbal: the address's second line.",
  })
  address2!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'A place near the address the rider can ask for, such as "near Jamia Masjid". Hatti\'s ' +
      'own: `formatted` has it too, for labels.',
  })
  landmark!: string | null;

  @Field()
  city!: string;

  @Field(() => String, { nullable: true, description: 'Province or territory, e.g. "Sindh".' })
  province!: string | null;

  @Field(() => String, { nullable: true, description: 'ISO 3166-2:PK code, e.g. "SD".' })
  provinceCode!: string | null;

  @Field(() => String, { nullable: true })
  zip!: string | null;

  @Field(() => Float, {
    nullable: true,
    description:
      "Where the address is on the map, in decimal degrees, as the customer's phone found it " +
      'there (ADR-259); null without a pin.',
  })
  latitude!: number | null;

  @Field(() => Float, { nullable: true, description: 'With `latitude`.' })
  longitude!: number | null;

  @Field(() => [String], { description: 'The address as lines for a label.' })
  formatted!: string[];
}

@ObjectType({ description: 'A line of an order: what was sold, as it was then.' })
export class OrderLineItem {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The product's title when it was sold." })
  title!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Money)
  unitPrice!: Money;

  @Field(() => Money)
  totalPrice!: Money;

  @Field(() => ID, { description: 'The variant sold. It may have been deleted since.' })
  variantId!: string;

  @Field(() => ID)
  productId!: string;

  @Field(() => Int, { description: 'Units shipped so far.' })
  fulfilledQuantity!: number;

  @Field(() => Int, {
    description: 'Units still to ship; none once the order is closed or cancelled.',
  })
  fulfillableQuantity!: number;

  @Field({
    description: "Whether its variant's price included the shop's sales tax when it was sold.",
  })
  taxable!: boolean;

  @Field(() => [TaxLine], {
    description:
      "The sales tax its price included, after its share of the order's discount; none when " +
      'it was not taxed.',
  })
  taxLines!: TaxLine[];
}

@ObjectType({ description: "A parcel's courier and tracking number." })
export class TrackingInfo {
  @Field(() => String, { nullable: true, description: 'e.g. "TCS", "Leopards", "PostEx".' })
  company!: string | null;

  @Field(() => String, { nullable: true })
  number!: string | null;

  @Field(() => String, { nullable: true, description: 'Where the customer can follow it.' })
  url!: string | null;
}

@ObjectType({ description: 'Units of an order line in a parcel.' })
export class FulfillmentLineItem {
  @Field(() => OrderLineItem)
  lineItem!: OrderLineItem;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'Once the parcel came back: how many went back on the shelf; the rest were written off.',
  })
  restockedQuantity!: number | null;
}

@ObjectType({
  description:
    'A claim on the courier that lost a parcel, or brought it back damaged (COD-09): the lost ' +
    "parcel's worth, or what of it was written off, unless the shop said otherwise, followed " +
    'until the courier pays it, in a statement or otherwise, or refuses it, or the shop ' +
    'withdraws it.',
})
export class FulfillmentClaim {
  @Field(() => FulfillmentClaimStatus)
  status!: FulfillmentClaimStatus;

  @Field(() => Money, { description: 'What the shop claims.' })
  amount!: Money;

  @Field(() => Money, { nullable: true, description: 'What the courier paid on it, once paid.' })
  paid!: Money | null;

  @Field(() => String, {
    nullable: true,
    description: "The shop's own words: the courier's claim number, or why it was refused.",
  })
  note!: string | null;

  @Field(() => GraphQLISODateTime)
  claimedAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was paid, refused or withdrawn; null while open.',
  })
  settledAt!: Date | null;
}

@ObjectType({
  description: 'A parcel: items of an order shipped together, and what became of them.',
})
export class Fulfillment {
  @Field(() => ID)
  id!: string;

  @Field(() => FulfillmentStatus)
  status!: FulfillmentStatus;

  @Field(() => TrackingInfo)
  trackingInfo!: TrackingInfo;

  @Field(() => [FulfillmentLineItem])
  fulfillmentLineItems!: FulfillmentLineItem[];

  @Field(() => GraphQLISODateTime)
  shippedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  deliveredAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it started coming back.' })
  returningAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it was checked back in.' })
  returnedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was marked lost by its courier; kept if it turns up.',
  })
  lostAt!: Date | null;

  @Field(() => Money, {
    nullable: true,
    description:
      "What couriers' statements charged for it, both ways, as codRemittanceImport took them: " +
      'for a parcel that came back, what its return cost in charges. Null while none has.',
  })
  courierCharges!: Money | null;

  @Field(() => FulfillmentClaim, {
    nullable: true,
    description:
      'Its claim on the courier that lost it: fulfillmentClaimCreate files one, and ' +
      'codRemittanceImport pays it from a statement. Null while it has none.',
  })
  claim!: FulfillmentClaim | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** For field resolvers. */
  locationId!: string;
}

@ObjectType({
  description:
    "An entry of an order's timeline: something that happened to it, or a comment staff or an app " +
    'wrote on it (ADR-128).',
})
export class OrderEvent {
  @Field(() => ID, { description: "An event's oev_…, a comment's ocm_…." })
  id!: string;

  @Field({
    description:
      'e.g. "created", "confirmed", "cancelled", "updated", "paid", or "comment" for what staff ' +
      'or an app wrote.',
  })
  kind!: string;

  @Field({ description: "What happened, in words for staff; a comment's own words." })
  message!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      "When a comment's author last changed it; null for what happened, and for comments as " +
      'they were written.',
  })
  editedAt!: Date | null;

  /** Who made it, for the core's `author`: an app's token, a member of staff, or the system. */
  actorKind!: 'app' | 'staff' | 'system';
  actorId!: string | null;
}

@ObjectType({
  description:
    "A step of a parcel's way to its customer, as its courier said it through Hatti, or as staff " +
    "or an app recorded it (ADR-160); the customer's order page shows each.",
})
export class FulfillmentEvent {
  @Field(() => ID)
  id!: string;

  @Field(() => FulfillmentEventStatus)
  status!: FulfillmentEventStatus;

  @Field(() => String, {
    nullable: true,
    description:
      'The courier\'s words, as "PostEx WareHouse", or the shop\'s own; none once the ' +
      "customer's data was erased.",
  })
  message!: string | null;

  @Field(() => GraphQLISODateTime, { description: 'When it happened.' })
  happenedAt!: Date;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class FulfillmentEventEdge {
  @Field()
  cursor!: string;

  @Field(() => FulfillmentEvent)
  node!: FulfillmentEvent;
}

@ObjectType()
export class FulfillmentEventConnection {
  @Field(() => [FulfillmentEventEdge])
  edges!: FulfillmentEventEdge[];

  @Field(() => [FulfillmentEvent])
  nodes!: FulfillmentEvent[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@InputType({
  description: "A step of a parcel's way that a courier Hatti does not follow told of.",
})
export class FulfillmentEventInput {
  @Field(() => ID)
  fulfillmentId!: string;

  @Field(() => FulfillmentEventStatus, {
    description:
      'IN_TRANSIT, OUT_FOR_DELIVERY or ATTEMPTED_DELIVERY: fulfillmentMarkDelivered and ' +
      'fulfillmentMarkReturning mark the rest.',
  })
  status!: FulfillmentEventStatus;

  @Field(() => String, { nullable: true, description: 'What the courier said; 200 characters.' })
  message?: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it happened; now if left out.',
  })
  happenedAt?: Date | null;
}

@ObjectType()
export class FulfillmentEventCreatePayload {
  @Field(() => FulfillmentEvent, { nullable: true })
  fulfillmentEvent!: FulfillmentEvent | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderEventEdge {
  @Field()
  cursor!: string;

  @Field(() => OrderEvent)
  node!: OrderEvent;
}

@ObjectType()
export class OrderEventConnection {
  @Field(() => [OrderEventEdge])
  edges!: OrderEventEdge[];

  @Field(() => [OrderEvent])
  nodes!: OrderEvent[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType({ description: "An order's link for its customer." })
export class OrderCustomerLink {
  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'When it stops working: at the time it was made to expire, or 30 days after the order is ' +
      'closed or cancelled, whichever comes first. Null while the order is open, for a link ' +
      'made to last.',
  })
  expiresAt!: Date | null;
}

@ObjectType({
  description:
    'What the customer agreed to in placing the order through checkout, or confirming it or ' +
    'its draft through a link, and where they did it from: an e-contract log, as ' +
    "Pakistan's Electronic Transactions Ordinance lets online contracts stand.",
})
export class OrderAgreement {
  @Field(() => GraphQLISODateTime, {
    description:
      'When: when the order was placed, or for one staff or an app placed, when its customer ' +
      'confirmed it through its link.',
  })
  agreedAt!: Date;

  @Field(() => String, {
    nullable: true,
    description:
      "The address the customer's browser agreed from, as Shopify's client details give it; " +
      "null for staff who see customers' numbers masked, and once the customer's data is erased.",
  })
  ip!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The customer's browser, as it named itself; null when ip is.",
  })
  userAgent!: string | null;

  /** The versions of the shop's policies agreed to, for the field that shows them. */
  policyVersionIds!: string[];
}

@ObjectType({
  description:
    "A visit's UTM parameters, as its landing page's query gave them: the shop's own words for " +
    'the link the shopper followed.',
})
export class UTMParameters {
  @Field(() => String, {
    nullable: true,
    description: 'utm_source: where the link was, such as "facebook" or "newsletter".',
  })
  source!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'utm_medium: the kind of link, such as "paid_social", "email" or "influencer".',
  })
  medium!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'utm_campaign: the campaign, such as "eid-sale".',
  })
  campaign!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "utm_term: the search terms bought, for a search ad's link.",
  })
  term!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'utm_content: which ad or link of the campaign, such as "red-kurta-video".',
  })
  content!: string | null;
}

@ObjectType({
  description:
    'A visit to the online store that led to an order (ADR-139): when it began, where it came ' +
    "from and the page it landed on, as the shopper's browser kept them.",
})
export class CustomerVisit {
  @Field(() => GraphQLISODateTime, { description: 'When it began.' })
  occurredAt!: Date;

  @Field(() => String, {
    description:
      "Where it came from: its link's utm_source, in lower case; else the platform of the ad " +
      'clicked or of the site linking to it, such as "facebook", "instagram", "google", ' +
      '"tiktok" or "whatsapp", or that site\'s domain; else "direct".',
  })
  source!: string;

  @Field(() => UTMParameters, {
    nullable: true,
    description: "Its landing page's UTM parameters; null where it had none.",
  })
  utmParameters!: UTMParameters | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The address it began at, its query with it; null once the customer's data is erased.",
  })
  landingPage!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The page on another site that linked to it, without its query; null when the browser ' +
      "said none, and once the customer's data is erased.",
  })
  referrerUrl!: string | null;
}

@ObjectType({
  description:
    'How the customer came to the online store before placing the order (ORD-13, ADR-139): ' +
    'their first visit, and their last from elsewhere, in the 30 days before they began ' +
    "checking out, as Shopify's customer journey has them.",
})
export class CustomerJourneySummary {
  @Field(() => CustomerVisit, { description: 'Their first visit.' })
  firstVisit!: CustomerVisit;

  @Field(() => CustomerVisit, {
    description:
      'Their last visit from another site, an ad or a tagged link before the order: the first, ' +
      'when there was no other.',
  })
  lastVisit!: CustomerVisit;

  @Field(() => Int, { description: 'Whole days from the first visit to the order.' })
  daysToConversion!: number;
}

export enum ReturnStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(ReturnStatus, {
  name: 'ReturnStatus',
  description: 'Where a customer return is (ADR-136).',
  valuesMap: {
    OPEN: { description: 'Recorded; its items are on their way back.' },
    CLOSED: { description: 'Checked in: its items back in stock or written off.' },
    CANCELLED: { description: 'Nothing came back after all.' },
  },
});

export enum ReturnReason {
  SIZE_TOO_SMALL = 'SIZE_TOO_SMALL',
  SIZE_TOO_LARGE = 'SIZE_TOO_LARGE',
  UNWANTED = 'UNWANTED',
  NOT_AS_DESCRIBED = 'NOT_AS_DESCRIBED',
  WRONG_ITEM = 'WRONG_ITEM',
  DEFECTIVE = 'DEFECTIVE',
  OTHER = 'OTHER',
}

registerEnumType(ReturnReason, {
  name: 'ReturnReason',
  description: 'Why a customer sends an item back, as Shopify says it.',
});

export enum OrderReturnStatus {
  NO_RETURN = 'NO_RETURN',
  IN_PROGRESS = 'IN_PROGRESS',
  RETURNED = 'RETURNED',
}

registerEnumType(OrderReturnStatus, {
  name: 'OrderReturnStatus',
  description: "Whether an order's customer sent anything back.",
  valuesMap: {
    NO_RETURN: { description: 'No return, or only cancelled ones.' },
    IN_PROGRESS: { description: 'A return is on its way back.' },
    RETURNED: { description: 'Its returns were checked in.' },
  },
});

@ObjectType({ description: 'Units of an order line a customer sends back, and why.' })
export class ReturnLineItem {
  @Field(() => OrderLineItem)
  lineItem!: OrderLineItem;

  @Field(() => Int)
  quantity!: number;

  @Field(() => ReturnReason)
  returnReason!: ReturnReason;

  @Field(() => Int, {
    nullable: true,
    description: 'Once checked in: how many went back in stock; the rest were written off.',
  })
  restockedQuantity!: number | null;
}

@ObjectType({ description: 'The order a return sent in exchange (ADR-137).' })
export class ReturnExchangeOrder {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number as staff say it, such as #1002.' })
  name!: string;
}

@ObjectType({
  description:
    'A customer sending back items of a delivered parcel (ORD-07, ADR-136): recorded by staff, ' +
    'and checked in when it arrives. Money given back is a refund of its own.',
})
export class Return {
  @Field(() => ID)
  id!: string;

  @Field({ description: "The order's number and its return's, such as #1001-R1." })
  name!: string;

  @Field(() => ReturnStatus)
  status!: ReturnStatus;

  @Field(() => [ReturnLineItem])
  returnLineItems!: ReturnLineItem[];

  @Field(() => TrackingInfo, { description: 'How it comes back, when a courier brings it.' })
  trackingInfo!: TrackingInfo;

  @Field()
  note!: string;

  @Field(() => ReturnExchangeOrder, {
    nullable: true,
    description: 'The order sent at once in exchange, paid by what comes back as far as it goes.',
  })
  exchangeOrder!: ReturnExchangeOrder | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it was checked in.' })
  closedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt!: Date | null;

  /** For field resolvers. */
  locationId!: string;
}

@ObjectType({ description: 'The order another was merged into (ADR-132).' })
export class OrderMergedInto {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number as staff say it, such as #1001.' })
  name!: string;
}

@ObjectType({ description: 'The order another was split from (ADR-135).' })
export class OrderSplitFrom {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its number as staff say it, such as #1001.' })
  name!: string;
}

@ObjectType({ description: 'An order.' })
export class Order {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'How staff and customers refer to it, e.g. "#1001".' })
  name!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => OrderStage)
  stage!: OrderStage;

  @Field(() => OrderStatus)
  status!: OrderStatus;

  @Field(() => OrderConfirmationStatus)
  confirmationStatus!: OrderConfirmationStatus;

  @Field(() => OrderFinancialStatus)
  financialStatus!: OrderFinancialStatus;

  @Field(() => OrderFulfillmentStatus)
  fulfillmentStatus!: OrderFulfillmentStatus;

  @Field(() => OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @Field(() => OrderSource)
  source!: OrderSource;

  @Field(() => String, {
    nullable: true,
    description:
      "The customer's mobile number (E.164). Staff other than owners and managers see it " +
      'masked, "0300 ••••567"; confirmation agents reveal it with orderPhoneReveal, which is ' +
      'logged. Null once their details are erased.',
  })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => MailingAddress)
  shippingAddress!: MailingAddress;

  @Field(() => [OrderLineItem])
  lineItems!: OrderLineItem[];

  @Field(() => [Fulfillment], { description: 'Its parcels, oldest first.' })
  fulfillments!: Fulfillment[];

  @Field(() => [Refund], { description: 'Its refunds, oldest first.' })
  refunds!: Refund[];

  @Field(() => [Return], { description: "Its customer's returns, the first first (ADR-136)." })
  returns!: Return[];

  @Field(() => OrderReturnStatus)
  returnStatus!: OrderReturnStatus;

  @Field(() => Money)
  subtotalPrice!: Money;

  @Field(() => Money)
  totalDiscounts!: Money;

  @Field(() => [String], {
    description: 'The discount codes it was placed with, as the shop wrote them.',
  })
  discountCodes!: string[];

  @Field(() => Money, {
    description:
      'Of totalDiscounts, what checkout took off for paying by bank transfer, where the shop ' +
      "takes something off for it; the rest is the codes' or staff's.",
  })
  transferDiscount!: Money;

  @Field(() => Money, {
    description:
      'Of totalDiscounts, what checkout took off for paying online, where the shop takes ' +
      'something off for it (onlinePaymentSettings).',
  })
  onlineDiscount!: Money;

  @Field(() => Money)
  totalShippingPrice!: Money;

  @Field(() => Money, {
    description:
      'What it charges for paying on delivery, as checkout adds it where the shop charges one: ' +
      'in its total and in the cash collected, apart from delivery.',
  })
  codFee!: Money;

  @Field(() => Money, {
    description: 'subtotalPrice − totalDiscounts + totalShippingPrice + codFee.',
  })
  totalPrice!: Money;

  @Field({
    description:
      "Always true: prices include sales tax, as Pakistan's consumer laws ask prices to be " +
      'shown, so the tax is part of totalPrice, never added to it.',
  })
  taxesIncluded!: boolean;

  @Field(() => Money, {
    description:
      "The sales tax included in totalPrice, at the shop's rate when it was placed: its lines', " +
      "and its delivery charge's and fee's where the shop's include it. Zero when the shop " +
      'charged none.',
  })
  totalTax!: Money;

  @Field(() => [TaxLine], { description: 'Its sales tax by rate, its lines and charges together.' })
  taxLines!: TaxLine[];

  @Field(() => Money, {
    description: 'The sales tax it keeps now: totalTax, less what its refunds gave back.',
  })
  currentTotalTax!: Money;

  @Field(() => Money, { description: 'Received so far. Refunds do not lower it.' })
  amountPaid!: Money;

  @Field(() => Money, { description: 'Given back since, in refunds; never more than was paid.' })
  amountRefunded!: Money;

  @Field(() => Money, { description: 'What the courier collects at the door.' })
  codAmount!: Money;

  @Field(() => Money, {
    description:
      'What a cash-on-delivery order asks for in advance, by bank transfer, before it ships: it ' +
      'waits for it at AWAITING_PAYMENT. Zero for none; received, it counts in amountPaid.',
  })
  advanceDue!: Money;

  @Field(() => BankAccount, {
    nullable: true,
    description:
      "The account a bank-transfer order's customer was told to pay into, as it was when it was " +
      'placed; null for other orders, and when the shop had none.',
  })
  bankAccount!: BankAccount | null;

  @Field()
  note!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => OrderCancelReason, { nullable: true })
  cancelReason!: OrderCancelReason | null;

  @Field(() => OrderMergedInto, {
    nullable: true,
    description: 'The order it was merged into, as its customer placed one order, not two.',
  })
  mergedInto!: OrderMergedInto | null;

  @Field(() => OrderSplitFrom, {
    nullable: true,
    description:
      'The order it was split from, its items sent apart: the first one, when a part was split ' +
      'again.',
  })
  splitFrom!: OrderSplitFrom | null;

  @Field(() => OrderRisk, {
    nullable: true,
    description: 'Cash-on-delivery orders only. Held ones wait at stage NEEDS_REVIEW.',
  })
  risk!: OrderRisk | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      "When the customer's details on it were erased, at their request: their name, number, " +
      'email, street, the note and where they placed it from. It keeps the rest, for the ' +
      'accounts.',
  })
  customerErasedAt!: Date | null;

  @Field({
    description:
      "Whether it came in past the orders the shop's plan allows in a month (ADR-263): its " +
      "customer's name, number, email and street are hidden, and it can't be confirmed, packed, " +
      'booked or shipped, until the shop chooses a bigger plan, or another order of its month is ' +
      'cancelled. Its customer is none the wiser: told of it as of any order, they may confirm it.',
  })
  overPlanLimit!: boolean;

  @Field(() => OrderCustomerLink, {
    nullable: true,
    description:
      "The customer's link, where they follow the order and act on it while they may; null " +
      'without one. orderLinkCreate makes one.',
  })
  customerLink!: OrderCustomerLink | null;

  @Field(() => OrderAgreement, {
    nullable: true,
    description:
      'What its customer agreed to in placing it through checkout, or confirming it or its ' +
      'draft through a link; null for orders staff and apps placed that their customers have ' +
      'not confirmed so.',
  })
  agreement!: OrderAgreement | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  confirmedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was marked packed, which moves it from TO_PACK to TO_BOOK.',
  })
  packedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  paidAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  closedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was given to its assignee, the member of staff seeing it through.',
  })
  assignedAt!: Date | null;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  /** For field resolvers. */
  uuid!: string;
  locationId!: string;
  customerId!: string;
  /** The account of the member of staff it is given to, for the core's `assignee` (ADR-127). */
  assigneeId!: string | null;
}

@ObjectType()
export class OrderEdge {
  @Field()
  cursor!: string;

  @Field(() => Order)
  node!: Order;
}

@ObjectType()
export class OrderConnection {
  @Field(() => [OrderEdge])
  edges!: OrderEdge[];

  @Field(() => [Order])
  nodes!: Order[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ObjectType()
export class OrderStageCount {
  @Field(() => OrderStage)
  stage!: OrderStage;

  @Field(() => Int)
  count!: number;
}

@ArgsType()
export class OrdersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An order number ("1001" or "#1001"), a mobile number in any format, a tracking number, ' +
      "or words of the customer's name, city or email; with filters among them, as Shopify's " +
      'search syntax writes them: `stage:to_pack`, `risk_level:high`, `tag:"gift wrap"`, or ' +
      '`-source:online_store` for the orders a filter does not match. Filters are stage, status, ' +
      'confirmation_status, financial_status, fulfillment_status, payment_method, source, ' +
      'risk_level, tag, has_transfer_receipt, each with the values of its field in lowercase, and ' +
      "assignee: me, none or a member of staff's ID (usr_…); any other is refused.",
  })
  query?: string | null;

  @Field(() => OrderStage, { nullable: true })
  stage?: OrderStage | null;

  @Field(() => OrderRiskLevel, { nullable: true })
  riskLevel?: OrderRiskLevel | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Placed at or after this.' })
  placedFrom?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Placed before this.' })
  placedBefore?: Date | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Only orders whose customer sent a receipt for their bank transfer (true), or only those ' +
      'with none (false).',
  })
  hasTransferReceipt?: boolean | null;
}

@ObjectType({
  description:
    "How a customer's orders turned out, as the Confirmation Desk shows it before a call. Worked " +
    'out from the orders when asked for.',
})
export class CustomerDeliveryHistory {
  @Field(() => Int, { description: 'Delivered, paid for or not.' })
  delivered!: number;

  @Field(() => Int, { description: 'Refused or undeliverable: coming back, or back.' })
  returned!: number;

  @Field(() => Int, {
    description:
      'Lost by the courier before reaching them: not their doing, so not among those returned. ' +
      'One they refused that the courier then lost on its way back is returned.',
  })
  lost!: number;

  @Field(() => Int, { description: 'Cancelled before shipping.' })
  cancelled!: number;

  @Field(() => Int, {
    description: 'Still under way: to confirm, review or ship, or on the way to the customer.',
  })
  inProgress!: number;
}

@ArgsType()
export class CustomerOrdersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ArgsType()
export class OrderEventsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType()
export class MailingAddressInput {
  @Field()
  name!: string;

  @Field({ description: 'A Pakistani mobile number, in any common format.' })
  phone!: string;

  @Field({ description: 'The house and street: "House 12, Street 4, Block 5".' })
  address1!: string;

  @Field(() => String, { nullable: true, description: 'The area: "Gulshan-e-Iqbal".' })
  address2?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A place near the address the rider can ask for: "near Jamia Masjid".',
  })
  landmark?: string | null;

  @Field({ description: 'Known cities are spelled the standard way: "khi" becomes "Karachi".' })
  city!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Code ("SD"), name ("Sindh") or alias ("KPK"); from the city when left out.',
  })
  province?: string | null;

  @Field(() => String, { nullable: true })
  zip?: string | null;

  @Field(() => Float, {
    nullable: true,
    description:
      "Hatti's own: where the address is on the map, in decimal degrees, as the customer shared " +
      'it, such as from a WhatsApp location; with `longitude`, in Pakistan and near the city ' +
      '(ADR-259). The address replaced without it has no pin.',
  })
  latitude?: number | null;

  @Field(() => Float, { nullable: true, description: 'With `latitude`.' })
  longitude?: number | null;
}

@InputType()
export class OrderLineItemInput {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => String, {
    nullable: true,
    description: 'Replaces the variant\'s price, e.g. one agreed in chat. Decimal, e.g. "2,499".',
  })
  price?: string | null;
}

@InputType()
export class OrderCreateInput {
  @Field(() => [OrderLineItemInput], { description: 'Up to 100.' })
  lineItems!: OrderLineItemInput[];

  @Field(() => MailingAddressInput)
  shippingAddress!: MailingAddressInput;

  @Field(() => String, { nullable: true })
  email?: string | null;

  @Field(() => OrderPaymentMethod, {
    nullable: true,
    description:
      'Default CASH_ON_DELIVERY. A BANK_TRANSFER order waits at AWAITING_PAYMENT, with the ' +
      "shop's account from bankTransferSettings if it has one, on or off at checkout; an " +
      "ONLINE one too, for its customer to pay through the shop's payment gateway from its link.",
  })
  paymentMethod?: OrderPaymentMethod | null;

  @Field(() => String, {
    nullable: true,
    description: 'Paid in advance on a cash-on-delivery order, such as the delivery charge.',
  })
  advancePaid?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Asked for in advance on a cash-on-delivery order, by bank transfer to the shop's " +
      'account, before it ships: the order waits for it, and the courier collects the rest. Not ' +
      'with advancePaid.',
  })
  advanceDue?: string | null;

  @Field(() => String, { nullable: true })
  shippingPrice?: string | null;

  @Field(() => String, { nullable: true, description: 'Taken off the items, as an amount.' })
  discount?: string | null;

  @Field(() => ID, {
    nullable: true,
    description:
      'Where it ships from and its stock is committed; by default the first location fulfilling ' +
      'online orders with all of it for sale, the primary first, or the primary.',
  })
  locationId?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class OrderUpdateInput {
  @Field(() => MailingAddressInput, {
    nullable: true,
    description: 'Replaces the whole address. Only before anything has shipped.',
  })
  shippingAddress?: MailingAddressInput | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  email?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@ObjectType()
export class OrderCreatePayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderUpdatePayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderConfirmPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderCancelPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderPhoneRevealPayload {
  @Field(() => String, {
    nullable: true,
    description: "E.164; null once the customer's details are erased.",
  })
  phone!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderMarkPackedPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderLocationChangePayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderMarkUnpackedPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'What a bulk action did. Each order is changed on its own, so one that fails leaves the ' +
    'others done.',
})
export class OrderBulkPayload {
  @Field(() => [Order], {
    description: 'The orders now as asked, in the order given; those that failed are left out.',
  })
  orders!: Order[];

  @Field(() => [UserError], {
    description: 'Why orders failed; each field is ["ids", the index of the order\'s ID].',
  })
  userErrors!: UserError[];
}

@ObjectType()
export class OrderLinkCreatePayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The page where the customer sees the order and, while it waits for them, confirms or ' +
      'cancels it. Shown once: Hatti keeps only a digest of it.',
  })
  url!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Opens WhatsApp with a message carrying the link: to the customer's number for staff who " +
      'see numbers whole, and apps; to a chat of your choosing for the rest.',
  })
  whatsappUrl!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderCreateManualPaymentPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderPayWithStoreCreditPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderMarkAsPaidPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class OrderRefundInput {
  @Field({
    description:
      'How much, like "2000" or "499.50": at most what was paid on the order and not refunded yet.',
  })
  amount!: string;

  @Field(() => RefundMethod)
  method!: RefundMethod;

  @Field(() => String, {
    nullable: true,
    description:
      "The transfer's reference, such as a wallet transaction ID. Not for ONLINE or " +
      "STORE_CREDIT: the gateway's, or the credit's, is recorded.",
  })
  reference?: string | null;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'For STORE_CREDIT: when the credit expires; never, unless given.',
  })
  storeCreditExpiresAt?: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      'For money staff sent, by BANK_TRANSFER, MOBILE_WALLET, CASH or OTHER: its receipt, a ' +
      'photo, a screenshot or a PDF of at most 10 MiB, by the resourceUrl of the upload ' +
      'stagedUploadsCreate staged for it. The refund keeps it with its order (ADR-242); it is ' +
      "not made one of the shop's files.",
  })
  receipt?: string | null;
}

@InputType()
export class OrderLineItemQuantityInput {
  @Field(() => ID)
  lineItemId!: string;

  @Field(() => Int, { description: '0 takes the line off.' })
  quantity!: number;
}

@InputType({ description: "What changes in an order's items; lines left out stay as they are." })
export class OrderEditLineItemsInput {
  @Field(() => [OrderLineItemQuantityInput], {
    nullable: true,
    description: "New quantities for the order's lines, up to 100.",
  })
  setQuantities?: OrderLineItemQuantityInput[] | null;

  @Field(() => [OrderLineItemInput], {
    nullable: true,
    description:
      'Variants to add, a line each at its price now or the price given, up to 100. A variant ' +
      "on the order already changes by its line's quantity instead.",
  })
  addVariants?: OrderLineItemInput[] | null;
}

@ObjectType()
export class OrderEditLineItemsPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType({
  description: 'What an order charges for delivery and takes off its items; those left out stay.',
})
export class OrderEditChargesInput {
  @Field(() => String, {
    nullable: true,
    description: 'Its delivery charge, decimal, e.g. "250"; "0" waives it.',
  })
  shippingPrice?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'What is taken off its items in all, decimal, e.g. "500", or "0" for nothing; at least what ' +
      'was taken off for paying by transfer, which is part of it.',
  })
  discount?: string | null;
}

@ObjectType()
export class OrderEditChargesPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class OrderSplitLineItemInput {
  @Field(() => ID)
  lineItemId!: string;

  @Field(() => Int, {
    description: "Units of the line to send apart, from 1 to all of the line's.",
  })
  quantity!: number;
}

@InputType({ description: "What of an order's items is sent apart, as an order of its own." })
export class OrderSplitInput {
  @Field(() => [OrderSplitLineItemInput], {
    description: "The order's lines and units to send apart, up to 100.",
  })
  lineItems!: OrderSplitLineItemInput[];

  @Field(() => String, {
    nullable: true,
    description:
      'The delivery charge of the order sent apart, decimal, e.g. "250"; nothing if left out, ' +
      'the shop sending it at its own cost.',
  })
  shippingPrice?: string | null;
}

@ObjectType()
export class OrderSplitPayload {
  @Field(() => Order, { nullable: true, description: 'The order split, with the items it keeps.' })
  order!: Order | null;

  @Field(() => Order, { nullable: true, description: 'The order its items were sent apart as.' })
  splitOrder!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class ReturnLineItemCreateInput {
  @Field(() => ID, { description: 'A delivered line of the order.' })
  lineItemId!: string;

  @Field(() => Int, { description: 'Units coming back: no more than were delivered and not back.' })
  quantity!: number;

  @Field(() => ReturnReason)
  returnReason!: ReturnReason;
}

@InputType({ description: 'How a return comes back, when a courier brings it.' })
export class ReturnTrackingInput {
  @Field(() => String, { nullable: true, description: 'e.g. "TCS", "Leopards", "PostEx".' })
  company?: string | null;

  @Field(() => String, { nullable: true })
  number?: string | null;
}

@InputType({ description: 'A customer return to record (ADR-136).' })
export class ReturnCreateInput {
  @Field(() => ID)
  orderId!: string;

  @Field(() => [ReturnLineItemCreateInput], {
    description: 'The delivered units coming back, up to 100 lines.',
  })
  returnLineItems!: ReturnLineItemCreateInput[];

  @Field(() => ID, {
    nullable: true,
    description:
      "Where it comes back to, and goes back in stock; the order's location if left out.",
  })
  locationId?: string | null;

  @Field(() => ReturnTrackingInput, { nullable: true })
  trackingInfo?: ReturnTrackingInput | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [OrderLineItemInput], {
    nullable: true,
    description:
      'Another size, or another item, to send at once for what comes back (ADR-137), up to 100 ' +
      "lines: an order of its own, confirmed, at the variants' prices now unless a price is " +
      'given, paid by what was paid for the items coming back as far as that goes, the rest ' +
      'collected at the door.',
  })
  exchangeLineItems?: OrderLineItemInput[] | null;

  @Field(() => String, {
    nullable: true,
    description: "The exchange's delivery charge, decimal; nothing if left out.",
  })
  exchangeShippingPrice?: string | null;
}

@InputType()
export class ReturnRestockInput {
  @Field(() => ID, { description: 'An order line in the return.' })
  lineItemId!: string;

  @Field(() => Int, { description: 'Units going back in stock; the rest are written off.' })
  quantity!: number;
}

@ObjectType()
export class ReturnCreatePayload {
  @Field(() => Return, { nullable: true })
  return!: Return | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ReturnReceivePayload {
  @Field(() => Return, { nullable: true })
  return!: Return | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ReturnCancelPayload {
  @Field(() => Return, { nullable: true })
  return!: Return | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderMergePayload {
  @Field(() => Order, { nullable: true, description: 'The order merged into, with its items.' })
  order!: Order | null;

  @Field(() => Order, { nullable: true, description: 'The order merged, cancelled as MERGED.' })
  mergedOrder!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderCommentCreatePayload {
  @Field(() => OrderEvent, { nullable: true })
  comment!: OrderEvent | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderCommentUpdatePayload {
  @Field(() => OrderEvent, { nullable: true })
  comment!: OrderEvent | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderCommentDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedCommentId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class OrderRefundPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => Refund, { nullable: true })
  refund!: Refund | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType({ description: 'Replaces the tracking a parcel had; fields left out are cleared.' })
export class FulfillmentTrackingInput {
  @Field(() => String, { nullable: true, description: 'e.g. "TCS", "Leopards", "PostEx".' })
  company?: string | null;

  @Field(() => String, { nullable: true })
  number?: string | null;

  @Field(() => String, { nullable: true, description: 'An https URL.' })
  url?: string | null;
}

@InputType()
export class OrderFulfillLineItemInput {
  @Field(() => ID, { description: 'The order line.' })
  id!: string;

  @Field(() => Int)
  quantity!: number;
}

@InputType()
export class OrderFulfillInput {
  @Field(() => [OrderFulfillLineItemInput], {
    nullable: true,
    description: 'What goes in the parcel; everything left to ship if left out.',
  })
  lineItems?: OrderFulfillLineItemInput[] | null;

  @Field(() => FulfillmentTrackingInput, { nullable: true })
  trackingInfo?: FulfillmentTrackingInput | null;
}

@InputType()
export class FulfillmentRestockInput {
  @Field(() => ID, { description: 'An order line in the parcel.' })
  lineItemId!: string;

  @Field(() => Int, { description: 'Units going back on the shelf; the rest are written off.' })
  quantity!: number;
}

@ObjectType()
export class OrderFulfillPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentTrackingInfoUpdatePayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentMarkDeliveredPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentMarkReturningPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'A customer return still on its way (ADR-138): those longest on their way come first, to ' +
    'chase.',
})
export class OpenReturn {
  @Field(() => ID, { description: "The return's ID." })
  id!: string;

  @Field({ description: 'Such as "#1001-R1".' })
  name!: string;

  @Field(() => ID)
  orderId!: string;

  @Field(() => TrackingInfo, { description: 'How it comes back, when a courier brings it.' })
  trackingInfo!: TrackingInfo;

  @Field(() => String, {
    nullable: true,
    description: 'The order sent in exchange, such as "#1002", if one was.',
  })
  exchangeOrderName!: string | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was recorded.' })
  createdAt!: Date;

  @Field(() => Int, { description: 'Whole days since it was recorded.' })
  days!: number;

  @Field(() => Int, { description: 'Items coming back.' })
  units!: number;
}

@ObjectType()
export class OpenReturnEdge {
  @Field()
  cursor!: string;

  @Field(() => OpenReturn)
  node!: OpenReturn;
}

@ObjectType()
export class OpenReturnConnection {
  @Field(() => [OpenReturnEdge])
  edges!: OpenReturnEdge[];

  @Field(() => [OpenReturn])
  nodes!: OpenReturn[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class OpenReturnsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ObjectType({
  description:
    'A parcel on its way back to the shop, refused or undeliverable: those longest on their way ' +
    'come first, for chasing their couriers.',
})
export class ReturningParcel {
  @Field(() => ID, { description: "The parcel's (Fulfillment) ID." })
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'Such as "#1001".' })
  orderName!: string;

  @Field(() => TrackingInfo)
  trackingInfo!: TrackingInfo;

  @Field(() => GraphQLISODateTime)
  shippedAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When it started coming back.' })
  returningAt!: Date;

  @Field(() => Int, { description: 'Whole days since it started coming back.' })
  days!: number;

  @Field(() => Int, { description: 'Items in it.' })
  units!: number;
}

@ObjectType()
export class ReturningParcelEdge {
  @Field()
  cursor!: string;

  @Field(() => ReturningParcel)
  node!: ReturningParcel;
}

@ObjectType()
export class ReturningParcelConnection {
  @Field(() => [ReturningParcelEdge])
  edges!: ReturningParcelEdge[];

  @Field(() => [ReturningParcel])
  nodes!: ReturningParcel[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ReturningParcelsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'One courier\'s alone, as its parcels name it ("Leopards"), in any letter case.',
  })
  courier?: string | null;
}

@ObjectType({
  description:
    'A parcel the courier lost, with its worth and its claim: the longest lost come first, for ' +
    'following the claims up.',
})
export class LostParcel {
  @Field(() => ID, { description: "The parcel's (Fulfillment) ID." })
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'Such as "#1001".' })
  orderName!: string;

  @Field(() => TrackingInfo)
  trackingInfo!: TrackingInfo;

  @Field(() => GraphQLISODateTime)
  shippedAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When it was marked lost.' })
  lostAt!: Date;

  @Field(() => Int, { description: 'Whole days since it was marked lost.' })
  days!: number;

  @Field(() => Int, { description: 'Items in it.' })
  units!: number;

  @Field(() => Money, {
    description: 'Its items at their prices on the order: what a claim asks for unless told.',
  })
  worth!: Money;

  @Field(() => FulfillmentClaim, { nullable: true, description: 'Null while not claimed.' })
  claim!: FulfillmentClaim | null;
}

@ObjectType()
export class LostParcelEdge {
  @Field()
  cursor!: string;

  @Field(() => LostParcel)
  node!: LostParcel;
}

@ObjectType()
export class LostParcelConnection {
  @Field(() => [LostParcelEdge])
  edges!: LostParcelEdge[];

  @Field(() => [LostParcel])
  nodes!: LostParcel[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class LostParcelsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'One courier\'s alone, as its parcels name it ("Leopards"), in any letter case.',
  })
  courier?: string | null;

  @Field(() => [LostParcelClaimFilter], {
    nullable: true,
    description:
      'Those whose claims are in these states alone, UNCLAIMED for none yet; all if left out.',
  })
  claim?: LostParcelClaimFilter[] | null;
}

@ObjectType({
  description:
    'A parcel with a claim on its courier (COD-09): one it lost, or one that came back with ' +
    'items written off as damaged.',
})
export class ClaimedParcel {
  @Field(() => ID, { description: "The parcel's (Fulfillment) ID." })
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'Such as "#1001".' })
  orderName!: string;

  @Field(() => FulfillmentStatus, {
    description:
      'LOST; or RETURNED: back with items written off as damaged, or lost and then turned up.',
  })
  status!: FulfillmentStatus;

  @Field(() => TrackingInfo)
  trackingInfo!: TrackingInfo;

  @Field(() => FulfillmentClaim)
  claim!: FulfillmentClaim;
}

@ObjectType()
export class ClaimedParcelEdge {
  @Field()
  cursor!: string;

  @Field(() => ClaimedParcel)
  node!: ClaimedParcel;
}

@ObjectType()
export class ClaimedParcelConnection {
  @Field(() => [ClaimedParcelEdge])
  edges!: ClaimedParcelEdge[];

  @Field(() => [ClaimedParcel])
  nodes!: ClaimedParcel[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ParcelClaimsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'One courier\'s alone, as its parcels name it ("Leopards"), in any letter case.',
  })
  courier?: string | null;

  @Field(() => [FulfillmentClaimStatus], {
    nullable: true,
    description: 'Those in these states alone; all if left out.',
  })
  status?: FulfillmentClaimStatus[] | null;
}

@ObjectType()
export class FulfillmentClaimCreatePayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentClaimSettlePayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentMarkLostPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FulfillmentReceiveReturnPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description: "When risky cash-on-delivery orders wait for review: the shop's policy.",
})
export class OrderRiskSettings {
  @Field(() => Float, {
    nullable: true,
    description:
      'Cash-on-delivery orders whose risk score is this or more wait for review, at stage ' +
      'NEEDS_REVIEW; null holds none. Default 0.6, the HIGH level.',
  })
  holdAt!: number | null;

  @Field(() => Money, {
    description: 'Orders totalling this or more count as high value. Default Rs 15,000.',
  })
  highValue!: Money;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has the defaults.',
  })
  updatedAt!: Date | null;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class OrderRiskSettingsInput {
  @Field(() => Float, {
    nullable: true,
    description: 'From 0.01 to 1, in hundredths; null holds none.',
  })
  holdAt?: number | null;

  @Field(() => String, { nullable: true, description: 'Decimal, e.g. "15,000".' })
  highValue?: string | null;
}

@ObjectType()
export class OrderRiskSettingsUpdatePayload {
  @Field(() => OrderRiskSettings, { nullable: true })
  riskSettings!: OrderRiskSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

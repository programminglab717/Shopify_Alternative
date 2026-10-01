import { Money, PageInfo, UserError } from '@hatti/api';
import { TaxLine } from '@hatti/tax/public';
import { BankAccount } from './bank-transfer.types.js';
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
}

registerEnumType(RefundMethod, {
  name: 'RefundMethod',
  description: 'How a refund went back to the customer. Staff send the money; Hatti records it.',
  valuesMap: {
    BANK_TRANSFER: { description: 'To a bank account, such as by IBFT or Raast.' },
    MOBILE_WALLET: { description: 'To a JazzCash or Easypaisa wallet.' },
    CASH: { description: 'In cash.' },
    OTHER: { description: 'Another way; the note says which.' },
  },
});

@ObjectType({ description: 'Money given back on an order, as staff recorded it.' })
export class Refund {
  @Field(() => ID)
  id!: string;

  @Field(() => Money)
  amount!: Money;

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

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

export enum OrderPaymentMethod {
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  PREPAID = 'PREPAID',
  BANK_TRANSFER = 'BANK_TRANSFER',
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
}

registerEnumType(OrderCancelReason, {
  name: 'OrderCancelReason',
  valuesMap: {
    CUSTOMER: { description: 'The customer cancelled.' },
    NO_RESPONSE: { description: 'The customer could not be reached to confirm.' },
    FRAUD: { description: 'A fake or fraudulent order.' },
    INVENTORY: { description: 'Out of stock.' },
    OTHER: {},
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
    "A claim on the courier that lost a parcel (COD-09): the parcel's worth unless the shop said " +
    'otherwise, followed until the courier pays it, in a statement or otherwise, or refuses it, ' +
    'or the shop withdraws it.',
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

@ObjectType({ description: 'Something that happened to an order, for its timeline.' })
export class OrderEvent {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'e.g. "created", "confirmed", "cancelled", "updated", "paid".' })
  kind!: string;

  @Field()
  message!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
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
    'What the customer agreed to in placing the order through checkout, and where they placed ' +
    "it from: an e-contract log, as Pakistan's Electronic Transactions Ordinance lets online " +
    'contracts stand.',
})
export class OrderAgreement {
  @Field(() => GraphQLISODateTime, { description: 'When: when the order was placed.' })
  agreedAt!: Date;

  @Field(() => String, {
    nullable: true,
    description:
      "The address the customer's browser placed it from, as Shopify's client details give it; " +
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
      'What its customer agreed to in placing it through checkout; null for orders staff and ' +
      'apps placed.',
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
      "or words of the customer's name, city or email.",
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
      "shop's account from bankTransferSettings if it has one, on or off at checkout.",
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
    description: 'Where it ships from and its stock is committed; the primary location by default.',
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
    description: "The transfer's reference, such as a wallet transaction ID.",
  })
  reference?: string | null;

  @Field(() => String, { nullable: true, description: "Why, for the shop's records." })
  note?: string | null;
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

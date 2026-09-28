import { Money, PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
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
  TO_FULFILL = 'TO_FULFILL',
  PARTIALLY_FULFILLED = 'PARTIALLY_FULFILLED',
  IN_TRANSIT = 'IN_TRANSIT',
  RETURNING = 'RETURNING',
  DELIVERED = 'DELIVERED',
  RETURNED = 'RETURNED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(OrderStage, {
  name: 'OrderStage',
  description: 'Where an order is, as one state: the tabs of the order list.',
  valuesMap: {
    NEEDS_CONFIRMATION: { description: 'Cash on delivery, waiting for the customer to confirm.' },
    NEEDS_REVIEW: { description: 'Held for staff to check, e.g. a risky or duplicate order.' },
    TO_FULFILL: { description: 'Confirmed or paid; to pack and ship.' },
    PARTIALLY_FULFILLED: { description: 'Some items shipped, some still to ship.' },
    IN_TRANSIT: { description: 'Everything shipped; on its way.' },
    RETURNING: { description: 'Refused or undeliverable; on its way back.' },
    DELIVERED: { description: 'Delivered; waiting for the cash to be collected or remitted.' },
    RETURNED: { description: 'Came back and was checked in.' },
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

export enum OrderPaymentMethod {
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  PREPAID = 'PREPAID',
}

registerEnumType(OrderPaymentMethod, {
  name: 'OrderPaymentMethod',
  valuesMap: {
    CASH_ON_DELIVERY: { description: 'The courier collects the cash at the door.' },
    PREPAID: { description: 'Paid in full before shipping, e.g. by bank transfer or wallet.' },
  },
});

export enum OrderSource {
  MANUAL = 'MANUAL',
  API = 'API',
}

registerEnumType(OrderSource, {
  name: 'OrderSource',
  valuesMap: {
    MANUAL: { description: 'Entered by staff, e.g. from a WhatsApp or Instagram chat.' },
    API: { description: 'Sent by an app.' },
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
}

registerEnumType(FulfillmentStatus, {
  name: 'FulfillmentStatus',
  description: 'Where a parcel is.',
  valuesMap: {
    IN_TRANSIT: { description: 'Shipped; on its way to the customer.' },
    DELIVERED: { description: 'Delivered to the customer.' },
    RETURNING: { description: 'Refused or undeliverable; on its way back (return to origin).' },
    RETURNED: { description: 'Back, and checked in: its items restocked or written off.' },
  },
});

@ObjectType({ description: 'A delivery address in Pakistan.' })
export class OrderAddress {
  @Field()
  name!: string;

  @Field({ description: 'Mobile number in E.164 form; partly hidden from packers.' })
  phone!: string;

  @Field()
  address1!: string;

  @Field(() => String, { nullable: true })
  address2!: string | null;

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

  @Field({ description: "The customer's mobile number (E.164); partly hidden from packers." })
  phone!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => OrderAddress)
  shippingAddress!: OrderAddress;

  @Field(() => [OrderLineItem])
  lineItems!: OrderLineItem[];

  @Field(() => [Fulfillment], { description: 'Its parcels, oldest first.' })
  fulfillments!: Fulfillment[];

  @Field(() => Money)
  subtotalPrice!: Money;

  @Field(() => Money)
  totalDiscounts!: Money;

  @Field(() => Money)
  totalShippingPrice!: Money;

  @Field(() => Money)
  totalPrice!: Money;

  @Field(() => Money)
  amountPaid!: Money;

  @Field(() => Money, { description: 'What the courier collects at the door.' })
  codAmount!: Money;

  @Field()
  note!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => OrderCancelReason, { nullable: true })
  cancelReason!: OrderCancelReason | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  confirmedAt!: Date | null;

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
}

@ArgsType()
export class OrderEventsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType()
export class OrderAddressInput {
  @Field()
  name!: string;

  @Field({ description: 'A Pakistani mobile number, in any common format.' })
  phone!: string;

  @Field()
  address1!: string;

  @Field(() => String, { nullable: true, description: 'Often a landmark.' })
  address2?: string | null;

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

  @Field(() => OrderAddressInput)
  shippingAddress!: OrderAddressInput;

  @Field(() => String, { nullable: true })
  email?: string | null;

  @Field(() => OrderPaymentMethod, { nullable: true, description: 'Default CASH_ON_DELIVERY.' })
  paymentMethod?: OrderPaymentMethod | null;

  @Field(() => String, {
    nullable: true,
    description: 'Paid in advance on a cash-on-delivery order, such as the delivery charge.',
  })
  advancePaid?: string | null;

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
  @Field(() => OrderAddressInput, {
    nullable: true,
    description: 'Replaces the whole address. Only before anything has shipped.',
  })
  shippingAddress?: OrderAddressInput | null;

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
export class OrderMarkAsPaidPayload {
  @Field(() => Order, { nullable: true })
  order!: Order | null;

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

@ObjectType()
export class FulfillmentReceiveReturnPayload {
  @Field(() => Fulfillment, { nullable: true })
  fulfillment!: Fulfillment | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

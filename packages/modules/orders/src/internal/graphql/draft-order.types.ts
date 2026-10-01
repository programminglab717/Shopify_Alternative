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
import {
  MailingAddress,
  MailingAddressInput,
  OrderLineItemInput,
  OrderPaymentMethod,
  OrderSource,
} from './order.types.js';

export enum DraftOrderStatus {
  OPEN = 'OPEN',
  COMPLETED = 'COMPLETED',
}

registerEnumType(DraftOrderStatus, {
  name: 'DraftOrderStatus',
  valuesMap: {
    OPEN: { description: 'Being put together in a chat, or waiting for the customer to confirm.' },
    COMPLETED: { description: 'Placed as an order.' },
  },
});

@ObjectType({
  description: 'A line of a draft order: an item at the price agreed, as it was when added.',
})
export class DraftOrderLineItem {
  @Field({ description: "The product's title when it was added." })
  title!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Money, { description: 'The price agreed, which the order keeps.' })
  unitPrice!: Money;

  @Field(() => Money)
  totalPrice!: Money;

  @Field(() => ID, { description: 'The variant to sell. It may have been deleted since.' })
  variantId!: string;

  @Field(() => ID)
  productId!: string;
}

@ObjectType({
  description:
    'An order taken in a chat before it is placed: its items at the prices agreed and, once the ' +
    'customer sends it, their address. It holds no stock. Staff complete it when the customer ' +
    'agrees, or send the customer a link to confirm it, which places it.',
})
export class DraftOrder {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'How staff refer to it, e.g. "#D1".' })
  name!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => DraftOrderStatus)
  status!: DraftOrderStatus;

  @Field(() => OrderSource, { description: 'Where the conversation happened; the order takes it.' })
  source!: OrderSource;

  @Field(() => OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @Field(() => [DraftOrderLineItem])
  lineItems!: DraftOrderLineItem[];

  @Field(() => String, {
    nullable: true,
    description:
      "The customer's mobile number (E.164), masked as on orders; null until the draft has " +
      'their address.',
  })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => MailingAddress, {
    nullable: true,
    description: 'Null until the customer sends it; completing the draft, or sending it, needs it.',
  })
  shippingAddress!: MailingAddress | null;

  @Field(() => Money)
  subtotalPrice!: Money;

  @Field(() => Money)
  totalDiscounts!: Money;

  @Field(() => Money)
  totalShippingPrice!: Money;

  @Field(() => Money)
  totalPrice!: Money;

  @Field(() => Money, { description: 'Paid in advance on a cash-on-delivery order.' })
  advancePaid!: Money;

  @Field(() => Money, { description: 'What the courier will collect at the door.' })
  codAmount!: Money;

  @Field()
  note!: string;

  @Field(() => [String])
  tags!: string[];

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      "When the customer's link stops working; null without one. draftOrderLinkCreate makes one.",
  })
  linkExpiresAt!: Date | null;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  completedAt!: Date | null;

  /** For field resolvers. */
  locationId!: string | null;
  orderId!: string | null;
}

@ObjectType()
export class DraftOrderEdge {
  @Field()
  cursor!: string;

  @Field(() => DraftOrder)
  node!: DraftOrder;
}

@ObjectType()
export class DraftOrderConnection {
  @Field(() => [DraftOrderEdge])
  edges!: DraftOrderEdge[];

  @Field(() => [DraftOrder])
  nodes!: DraftOrder[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class DraftOrdersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => DraftOrderStatus, { nullable: true })
  status?: DraftOrderStatus | null;
}

@InputType({
  description:
    "A draft's fields. draftOrderCreate needs lineItems. draftOrderUpdate changes only the " +
    'fields given: null clears the address, email, amounts, location, note or tags, and leaves ' +
    'the source and payment method as they are. A draft always has line items.',
})
export class DraftOrderInput {
  @Field(() => [OrderLineItemInput], {
    nullable: true,
    description:
      "Up to 100. Replaces the lines, each at its price here or else the variant's price now: " +
      'the draft keeps that price.',
  })
  lineItems?: OrderLineItemInput[] | null;

  @Field(() => MailingAddressInput, {
    nullable: true,
    description: 'In a chat, the address often comes after the items.',
  })
  shippingAddress?: MailingAddressInput | null;

  @Field(() => String, { nullable: true })
  email?: string | null;

  @Field(() => OrderSource, {
    nullable: true,
    description: 'Where the conversation happened. Default MANUAL for staff, API for apps.',
  })
  source?: OrderSource | null;

  @Field(() => OrderPaymentMethod, {
    nullable: true,
    description:
      'Default CASH_ON_DELIVERY. A PREPAID draft is completed once the customer has paid; a ' +
      "BANK_TRANSFER draft's order waits at AWAITING_PAYMENT for the transfer.",
  })
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
    description: 'Where the order will ship from; the primary location when it is placed, if none.',
  })
  locationId?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;
}

@ObjectType()
export class DraftOrderCreatePayload {
  @Field(() => DraftOrder, { nullable: true })
  draftOrder!: DraftOrder | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DraftOrderUpdatePayload {
  @Field(() => DraftOrder, { nullable: true })
  draftOrder!: DraftOrder | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DraftOrderDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DraftOrderCompletePayload {
  @Field(() => DraftOrder, {
    nullable: true,
    description: 'Completed, with the order it became as its order field.',
  })
  draftOrder!: DraftOrder | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DraftOrderLinkCreatePayload {
  @Field(() => DraftOrder, { nullable: true })
  draftOrder!: DraftOrder | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The page where the customer sees the order, adds or corrects the address, and confirms ' +
      'it. Shown once: Hatti keeps only a digest of it.',
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

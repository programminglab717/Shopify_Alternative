import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'An item a payment link puts in each checkout it opens.' })
export class PaymentLinkItem {
  @Field(() => ID, { description: 'The variant. It may have been deleted since.' })
  variantId!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => String, {
    nullable: true,
    description:
      "The product's title, with the variant's where it has more than one; null once the " +
      'variant is gone.',
  })
  title!: string | null;
}

@ObjectType({
  description:
    'A link the shop shares once, on WhatsApp, Instagram or anywhere, that many customers open ' +
    '(PAY-04, ADR-248): each gets a checkout of their own with its items, its discount code ' +
    'applied, and places an order of their own, until the link closes.',
})
export class PaymentLink {
  @Field(() => ID)
  id!: string;

  @Field({ description: "For staff, as they find it among the shop's links." })
  title!: string;

  @Field({
    description:
      "Where customers open it, on the shop's storefront: /pay/<token>. It stays the same.",
  })
  url!: string;

  @Field(() => [PaymentLinkItem])
  items!: PaymentLinkItem[];

  @Field(() => String, { nullable: true, description: 'Applied to each checkout it opens.' })
  discountCode!: string | null;

  @Field({
    description:
      'Paid before it ships, by bank transfer or online: its checkouts offer no cash on delivery.',
  })
  prepaidOnly!: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'How many orders it takes before it closes; null for no limit.',
  })
  usageLimit!: number | null;

  @Field(() => Int, { description: 'The orders placed through it so far.' })
  ordersPlaced!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastOrderAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it closes, if ever.' })
  expiresAt!: Date | null;

  @Field({ description: 'False once staff closed it.' })
  active!: boolean;

  @Field({
    description:
      'Whether it opens checkouts and takes their orders now: active, not past its time, nor ' +
      'used up. Checkouts it opened stop taking orders once it closes.',
  })
  open!: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class PaymentLinkItemInput {
  @Field(() => ID, { description: "One of the shop's variants." })
  variantId!: string;

  @Field(() => Int, { nullable: true, description: '1 unless given; at most 10,000.' })
  quantity?: number | null;
}

@InputType({
  description: 'A new payment link, or what to change of one: a field left out stays as it is.',
})
export class PaymentLinkInput {
  @Field(() => String, { nullable: true, description: 'Required for a new link.' })
  title?: string | null;

  @Field(() => [PaymentLinkItemInput], {
    nullable: true,
    description: 'Required for a new link: 1 to 20, a variant given twice counted once.',
  })
  items?: PaymentLinkItemInput[] | null;

  @Field(() => String, {
    nullable: true,
    description: "One of the shop's discount codes; null or blank for none.",
  })
  discountCode?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'False unless given for a new link.' })
  prepaidOnly?: boolean | null;

  @Field(() => Int, { nullable: true, description: '1 to 100,000; null for no limit.' })
  usageLimit?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null for never.' })
  expiresAt?: Date | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'False closes the link; true opens it again. True unless given for a new link.',
  })
  active?: boolean | null;
}

@ObjectType()
export class PaymentLinkPayload {
  @Field(() => PaymentLink, { nullable: true })
  paymentLink!: PaymentLink | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

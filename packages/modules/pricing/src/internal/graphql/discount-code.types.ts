import { Money, PageInfo, UserError } from '@hatti/api';
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

export enum DiscountCodeKind {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  FREE_SHIPPING = 'FREE_SHIPPING',
}

registerEnumType(DiscountCodeKind, {
  name: 'DiscountCodeKind',
  description: 'What a discount code gives.',
  valuesMap: {
    PERCENTAGE: { description: "A percentage off the order's items." },
    FIXED_AMOUNT: { description: "An amount off the order's items." },
    FREE_SHIPPING: { description: 'Free delivery.' },
  },
});

export enum DiscountStatus {
  SCHEDULED = 'SCHEDULED',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
}

registerEnumType(DiscountStatus, {
  name: 'DiscountStatus',
  description: 'Whether a discount code works now, by its dates.',
  valuesMap: {
    SCHEDULED: { description: 'It starts later.' },
    ACTIVE: { description: 'It works now, if it has uses left.' },
    EXPIRED: { description: 'It has ended.' },
  },
});

@ObjectType({
  description:
    "A code shoppers enter for a percentage or an amount off an order's items, or for free " +
    "delivery, as Shopify's basic and free-shipping discount codes are (CHK-06).",
})
export class DiscountCode {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'As the shop wrote it; shoppers may type it in any letter case.' })
  code!: string;

  @Field({ description: 'What staff call it: the code unless given.' })
  title!: string;

  @Field(() => DiscountCodeKind)
  kind!: DiscountCodeKind;

  @Field(() => Float, {
    nullable: true,
    description: "Percent off the order's items, for PERCENTAGE codes: 12.5 is 12.5%.",
  })
  percentage!: number | null;

  @Field(() => Money, {
    nullable: true,
    description: "Off the order's items, for FIXED_AMOUNT codes, never more than they come to.",
  })
  amount!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: "What the order's items must come to for the code to work.",
  })
  minimumSubtotal!: Money | null;

  @Field(() => GraphQLISODateTime)
  startsAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endsAt!: Date | null;

  @Field(() => DiscountStatus)
  status!: DiscountStatus;

  @Field(() => Int, { nullable: true, description: 'Orders that may be placed with it, in all.' })
  usageLimit!: number | null;

  @Field({ description: 'Whether a customer may place only one order with it.' })
  oncePerCustomer!: boolean;

  @Field(() => Int, { description: 'Orders placed with it so far.' })
  usageCount!: number;

  @Field({
    description:
      'What it gives, in a line: "10% off orders of Rs 3,000 or more; one use a customer".',
  })
  summary!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class DiscountCodeEdge {
  @Field()
  cursor!: string;

  @Field(() => DiscountCode)
  node!: DiscountCode;
}

@ObjectType()
export class DiscountCodeConnection {
  @Field(() => [DiscountCodeEdge])
  edges!: DiscountCodeEdge[];

  @Field(() => [DiscountCode])
  nodes!: DiscountCode[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class DiscountCodesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Only codes whose code or title has this text, in any letter case.',
  })
  query?: string | null;
}

@InputType({
  description:
    'A discount code, or what changes of one: left out, a field stays as it is, and null clears ' +
    'one that may be empty. One of percentage, amount and freeShipping says what the code ' +
    'gives; giving another changes it.',
})
export class DiscountCodeInput {
  @Field(() => String, {
    nullable: true,
    description:
      'Letters, digits, hyphens and underscores, up to 64, like EID25; unique in the shop in ' +
      'any letter case. Needed to make one.',
  })
  code?: string | null;

  @Field(() => String, { nullable: true, description: 'What staff call it; the code if blank.' })
  title?: string | null;

  @Field(() => Float, {
    nullable: true,
    description: "Percent off the order's items, 0.01 to 100.",
  })
  percentage?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'An amount off the order\'s items, in the shop currency: "500".',
  })
  amount?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Free delivery.' })
  freeShipping?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description: 'What the order\'s items must come to for the code to work: "3,000".',
  })
  minimumSubtotal?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Now unless given.' })
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null for no end.' })
  endsAt?: Date | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Orders that may be placed with it, in all, 1 to 1,000,000; null for no limit.',
  })
  usageLimit?: number | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Whether a customer, by their mobile number, may place only one order with it.',
  })
  oncePerCustomer?: boolean | null;
}

@ObjectType()
export class DiscountCodeCreatePayload {
  @Field(() => DiscountCode, { nullable: true })
  discountCode!: DiscountCode | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DiscountCodeUpdatePayload {
  @Field(() => DiscountCode, { nullable: true })
  discountCode!: DiscountCode | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DiscountCodeDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedDiscountCodeId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

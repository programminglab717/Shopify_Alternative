import { Money, UserError } from '@hatti/api';
import { Field, Float, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { DiscountCodeKind, DiscountStatus } from './discount-code.types.js';

@ObjectType({
  description:
    'A discount given without a code to every cart and checkout that qualifies while it runs, as ' +
    "Shopify's automatic discounts are (CHK-06): a percentage or an amount off the order's items, " +
    'or free delivery. The one that takes most off the items applies, with free delivery beside ' +
    'it; with a code only where every one applied combines with codes.',
})
export class AutomaticDiscount {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'What shoppers see beside what it takes off: "Eid sale".' })
  title!: string;

  @Field(() => DiscountCodeKind)
  kind!: DiscountCodeKind;

  @Field(() => Float, {
    nullable: true,
    description:
      "Percent off the order's items, for PERCENTAGE discounts: 12.5 is 12.5%; for BUY_X_GET_Y, off " +
      'the items given.',
  })
  percentage!: number | null;

  @Field(() => Money, {
    nullable: true,
    description: "Off the order's items, for FIXED_AMOUNT discounts, never more than they come to.",
  })
  amount!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: "What the order's items must come to for it to apply.",
  })
  minimumSubtotal!: Money | null;

  @Field(() => GraphQLISODateTime)
  startsAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endsAt!: Date | null;

  @Field(() => DiscountStatus)
  status!: DiscountStatus;

  @Field({ description: 'Whether a discount code may be used with it.' })
  combinesWithCodes!: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'For BUY_X_GET_Y: items bought for each group.',
  })
  buyQuantity!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'For BUY_X_GET_Y: items given in each group, at percentage off.',
  })
  getQuantity!: number | null;

  @Field(() => [ID], {
    description:
      'The products whose items it is for, with those of its collections; neither, the whole order.',
  })
  productIds!: string[];

  @Field(() => [ID], { description: "The collections whose products' items it is for." })
  collectionIds!: string[];

  @Field({ description: 'What it gives, in a line: "10% off orders of Rs 3,000 or more".' })
  summary!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType({
  description:
    'An automatic discount, or what changes of one: left out, a field stays as it is, and null ' +
    'clears one that may be empty. One of percentage, amount and freeShipping says what it ' +
    'gives; giving another changes it.',
})
export class AutomaticDiscountInput {
  @Field(() => String, {
    nullable: true,
    description: 'What shoppers see beside what it takes off, up to 255 characters. Needed.',
  })
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
    description: 'What the order\'s items must come to for it to apply: "3,000".',
  })
  minimumSubtotal?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Now unless given.' })
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null for no end.' })
  endsAt?: Date | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Whether a discount code may be used with it; not unless given.',
  })
  combinesWithCodes?: boolean | null;

  @Field(() => [ID], {
    nullable: true,
    description:
      'The products whose items it is for, up to 100, with those of collectionIds; empty or ' +
      'null with collectionIds, the whole order. Not for free delivery.',
  })
  productIds?: string[] | null;

  @Field(() => [ID], {
    nullable: true,
    description: "The collections whose products' items it is for, up to 100.",
  })
  collectionIds?: string[] | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'Items bought for each group, 1 to 100: with getQuantity, it gives items for others ' +
      'bought (BUY_X_GET_Y), percentage off them, 100 unless given.',
  })
  buyQuantity?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Items given in each group, 1 to 100, the cheapest of them.',
  })
  getQuantity?: number | null;
}

@ObjectType()
export class AutomaticDiscountPayload {
  @Field(() => AutomaticDiscount, { nullable: true })
  automaticDiscount!: AutomaticDiscount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AutomaticDiscountDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedAutomaticDiscountId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

import { Money, UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'More off as more of a variant is bought (ADR-778).' })
export class PriceListQuantityBreak {
  @Field(() => Int, { description: 'From this many units of a variant in an order.' })
  minQuantity!: number;

  @Field({ description: 'Further off, in percent: "5".' })
  percentOff!: string;
}

@ObjectType({
  description:
    "A shop's wholesale prices, for the customers it gave a tag (CUS-06, ADR-778): a share off " +
    'every item, prices of its own for some variants, and more off as more of a variant is ' +
    "bought. A customer's draft orders are priced from it.",
})
export class PriceList {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({ description: 'The customers it is for: those with this tag, in any letter case.' })
  customerTag!: string;

  @Field({ description: 'Off every item without a price of its own, in percent: "10".' })
  percentOff!: string;

  @Field(() => [PriceListQuantityBreak], { description: 'The fewest units first.' })
  quantityBreaks!: PriceListQuantityBreak[];

  @Field(() => Int, { description: 'How many variants have a price of their own in it.' })
  pricedVariants!: number;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({ description: "A variant's price in a price list." })
export class PriceListPrice {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Money)
  price!: Money;
}

@InputType()
export class PriceListQuantityBreakInput {
  @Field(() => Int, { description: '2 or more, each break more than the one before.' })
  minQuantity!: number;

  @Field({ description: 'More than 0% and at most 90%, to two places.' })
  percentOff!: string;
}

@InputType()
export class PriceListInput {
  @Field(() => String, { nullable: true, description: 'Up to 100 characters.' })
  name?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The tag of the customers it is for, up to 40 characters: one list to a tag, in any ' +
      'letter case.',
  })
  customerTag?: string | null;

  @Field(() => String, { nullable: true, description: '0% to 90%, to two places; 0 for none.' })
  percentOff?: string | null;

  @Field(() => [PriceListQuantityBreakInput], {
    nullable: true,
    description: 'Up to five, the fewest units first; an empty list takes them all away.',
  })
  quantityBreaks?: PriceListQuantityBreakInput[] | null;
}

@InputType()
export class PriceListPriceInput {
  @Field(() => ID)
  variantId!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Its price in the list, as the shop writes it: "1850"; null takes it away.',
  })
  price?: string | null;
}

@ObjectType()
export class PriceListPayload {
  @Field(() => PriceList, { nullable: true })
  priceList!: PriceList | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PriceListDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedPriceListId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PriceListPricesSetPayload {
  @Field(() => [PriceListPrice], { nullable: true, description: "The list's prices after." })
  prices!: PriceListPrice[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

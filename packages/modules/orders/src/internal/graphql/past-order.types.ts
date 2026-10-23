import { PageInfo } from '@hatti/api';
import { ArgsType, Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'An amount of a past order (ADR-786), in the currency the store priced it in, which may be ' +
    'one Hatti does not take.',
})
export class PastOrderAmount {
  @Field({ description: 'Decimal amount in major units, e.g. "4500.00".' })
  amount!: string;

  @Field({ description: 'ISO 4217, e.g. "PKR".' })
  currencyCode!: string;
}

@ObjectType({ description: 'An item of a past order, as the store sold it.' })
export class PastOrderLine {
  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  variantTitle!: string | null;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int)
  quantity!: number;

  @Field(() => PastOrderAmount, { description: 'Each, before discounts.' })
  price!: PastOrderAmount;
}

@ObjectType({ description: 'Where a past order went, as the store wrote it.' })
export class PastOrderAddress {
  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true, description: 'Masked as Order.phone is.' })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  address1!: string | null;

  @Field(() => String, { nullable: true })
  address2!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => String, { nullable: true })
  province!: string | null;

  @Field(() => String, { nullable: true })
  zip!: string | null;

  @Field(() => String, { nullable: true, description: 'ISO 3166, e.g. "PK".' })
  countryCode!: string | null;
}

@ObjectType({
  description:
    'An order from the store the shop moved from (ONB-05, ADR-786), kept to look back on: it ' +
    'takes no stock, sends no messages and counts in no report, and nothing changes it.',
})
export class PastOrder {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Where it was placed: SHOPIFY.' })
  source!: string;

  @Field({ description: 'Its name there, as #1001.' })
  name!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'The customer its number was when it was brought, or since a merge.',
  })
  customerId!: string | null;

  @Field(() => String, { nullable: true, description: 'Masked as Order.phone is.' })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => GraphQLISODateTime)
  placedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt!: Date | null;

  @Field(() => PastOrderAmount)
  subtotal!: PastOrderAmount;

  @Field(() => PastOrderAmount)
  shipping!: PastOrderAmount;

  @Field(() => PastOrderAmount)
  discounts!: PastOrderAmount;

  @Field(() => PastOrderAmount)
  total!: PastOrderAmount;

  @Field(() => String, { nullable: true, description: "The store's words, as PAID or REFUNDED." })
  financialStatus!: string | null;

  @Field(() => String, { nullable: true, description: "The store's words, as FULFILLED." })
  fulfillmentStatus!: string | null;

  @Field(() => [PastOrderLine])
  lines!: PastOrderLine[];

  @Field(() => PastOrderAddress, { nullable: true })
  shippingAddress!: PastOrderAddress | null;

  @Field()
  note!: string;
}

@ObjectType()
export class PastOrderEdge {
  @Field()
  cursor!: string;

  @Field(() => PastOrder)
  node!: PastOrder;
}

@ObjectType()
export class PastOrderConnection {
  @Field(() => [PastOrderEdge])
  edges!: PastOrderEdge[];

  @Field(() => [PastOrder])
  nodes!: PastOrder[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class PastOrdersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ID, { nullable: true, description: "That customer's alone." })
  customerId?: string | null;
}

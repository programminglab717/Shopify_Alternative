import {
  ArgsType,
  Field,
  Float,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { COD_HEALTH_LIMITS } from '../cod-health.service.js';

export enum CodHealthDimension {
  CITY = 'CITY',
  PRODUCT = 'PRODUCT',
  SOURCE = 'SOURCE',
  COURIER = 'COURIER',
}

registerEnumType(CodHealthDimension, {
  name: 'CodHealthDimension',
  description: 'What COD health is broken down by.',
  valuesMap: {
    CITY: {
      description:
        'The city each order went to, as orders keep it: known cities by name, others as typed, ' +
        'in any letter case.',
    },
    PRODUCT: {
      description:
        'The products sold: an order counts for each product in it, and a parcel for each it ' +
        'carried.',
    },
    SOURCE: { description: 'Where the orders came from, as OrderSource says.' },
    COURIER: {
      description: 'The courier staff named when shipping each parcel. Parcels only.',
    },
  },
});

@ArgsType()
export class CodHealthArgs {
  @Field(() => GraphQLISODateTime, { description: 'Orders placed at or after this.' })
  placedFrom!: Date;

  @Field(() => GraphQLISODateTime, {
    description: `Orders placed before this; at most ${COD_HEALTH_LIMITS.days} days after placedFrom.`,
  })
  placedBefore!: Date;

  @Field(() => CodHealthDimension, {
    nullable: true,
    description: 'What to break it down by. Without it, `rows` is empty.',
  })
  by?: CodHealthDimension | null;

  @Field(() => Int, { nullable: true, description: 'Rows at most, 1 to 250; default 50.' })
  first?: number | null;
}

@ObjectType({ description: "How a period's cash-on-delivery orders went at confirmation." })
export class CodConfirmation {
  @Field(() => Int, { description: 'Cash-on-delivery orders placed.' })
  placed!: number;

  @Field(() => Int, { description: 'Confirmed by their customer or staff, whatever came after.' })
  confirmed!: number;

  @Field(() => Int, {
    description:
      'Cancelled before anyone confirmed them: declined, unreachable, fake or out of stock.',
  })
  cancelled!: number;

  @Field(() => Int, { description: 'Still to be confirmed or reviewed.' })
  awaiting!: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'Confirmed of those confirmed or cancelled, from 0 to 1; null while there are none. ' +
      'Orders still awaiting count once decided.',
  })
  rate!: number | null;
}

@ObjectType({ description: "How the orders' parcels went." })
export class CodDelivery {
  @Field(() => Int)
  shipped!: number;

  @Field(() => Int)
  delivered!: number;

  @Field(() => Int, { description: 'Refused or undeliverable: on their way back, or back.' })
  returned!: number;

  @Field(() => Int, { description: 'Still on their way to the customer.' })
  inTransit!: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'Delivered of those delivered or returned, from 0 to 1: the delivery success rate. Null ' +
      'while there are none; parcels in transit count once they arrive somewhere.',
  })
  successRate!: number | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Returned of those delivered or returned, from 0 to 1: the RTO rate.',
  })
  returnRate!: number | null;
}

@ObjectType({ description: 'COD health for one city, product, source or courier.' })
export class CodHealthRow {
  @Field(() => String, {
    nullable: true,
    description:
      "The city, the product's ID, the OrderSource value, or the courier as staff named it; " +
      'null for parcels shipped without a courier named.',
  })
  key!: string | null;

  @Field({ description: "What to call it: the product's title as last sold, for one." })
  title!: string;

  @Field(() => CodConfirmation, {
    nullable: true,
    description: 'Null by courier, since a courier is chosen after an order is confirmed.',
  })
  confirmation!: CodConfirmation | null;

  @Field(() => CodDelivery)
  delivery!: CodDelivery;
}

@ObjectType({
  description:
    "How a period's cash-on-delivery orders turned out (COD-12): confirmed of those placed, " +
    'and delivered and returned of their parcels.',
})
export class CodHealth {
  @Field(() => CodConfirmation)
  confirmation!: CodConfirmation;

  @Field(() => CodDelivery)
  delivery!: CodDelivery;

  @Field(() => [CodHealthRow], {
    description:
      'Broken down by what `by` names, most orders first (by courier, most parcels); empty ' +
      'without `by`.',
  })
  rows!: CodHealthRow[];
}

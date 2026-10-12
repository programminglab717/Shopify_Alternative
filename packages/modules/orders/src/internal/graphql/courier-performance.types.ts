import { Money } from '@hatti/api';
import { ArgsType, Field, Float, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';

@ArgsType()
export class CourierPerformanceArgs {
  @Field(() => GraphQLISODateTime, { description: 'Parcels shipped at or after this…' })
  shippedFrom!: Date;

  @Field(() => GraphQLISODateTime, {
    description: '…and before this: at most 366 days after shippedFrom.',
  })
  shippedBefore!: Date;

  @Field(() => Int, {
    defaultValue: 10,
    description: 'Cities each courier lists, the most parcels first: up to 50.',
  })
  cities!: number;
}

@ObjectType({ isAbstract: true })
export class CourierPerformanceTally {
  @Field(() => Int)
  shipped!: number;

  @Field(() => Int)
  delivered!: number;

  @Field(() => Int, { description: 'Refused or undeliverable: on their way back, or back.' })
  returned!: number;

  @Field(() => Int, { description: 'Lost before reaching the customer.' })
  lost!: number;

  @Field(() => Int, { description: 'Still on their way to the customer.' })
  inTransit!: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'Delivered of those delivered, returned or lost, from 0 to 1: how often the courier got a ' +
      'parcel to its customer. Null while none has arrived anywhere.',
  })
  deliveryRate!: number | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Returned of those delivered or returned, from 0 to 1: the RTO rate.',
  })
  returnRate!: number | null;

  @Field(() => Float, {
    nullable: true,
    description: 'The average days from shipped to delivered, to a tenth; null while none was.',
  })
  daysToDeliver!: number | null;

  @Field(() => Money, {
    description:
      'What statements charged for the parcels, else what rate cards say they are likely to ' +
      'cost as they stand (ADR-383).',
  })
  charges!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'The charges of the parcels charged or estimated, each; null while none is.',
  })
  chargePerParcel!: Money | null;

  @Field(() => Money, { description: 'Of charges, what rate cards estimate.' })
  chargesEstimated!: Money;
}

@ObjectType({ description: "A courier's parcels to one city (SHP-08, ADR-384)." })
export class CourierPerformanceCity extends CourierPerformanceTally {
  @Field({ description: 'The city as orders keep it, in the spelling most used.' })
  city!: string;
}

@ObjectType({
  description:
    "How a courier's parcels shipped in a period went (SHP-08, ADR-384), everywhere and city by " +
    'city: delivered, returned and lost, the days they took, and what they cost.',
})
export class CourierPerformance extends CourierPerformanceTally {
  @Field(() => String, {
    nullable: true,
    description: 'The courier as parcels were shipped with it; null for none named.',
  })
  courier!: string | null;

  @Field({ description: 'The courier, or "No courier named".' })
  title!: string;

  @Field(() => [CourierPerformanceCity], { description: 'The most parcels first.' })
  cities!: CourierPerformanceCity[];
}

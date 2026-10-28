import { Money } from '@hatti/api';
import { Field, Float, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum RfmGroupName {
  CHAMPIONS = 'CHAMPIONS',
  POTENTIAL_LOYALISTS = 'POTENTIAL_LOYALISTS',
  NEW_CUSTOMERS = 'NEW_CUSTOMERS',
  LOYAL = 'LOYAL',
  NEEDS_ATTENTION = 'NEEDS_ATTENTION',
  ABOUT_TO_SLEEP = 'ABOUT_TO_SLEEP',
  CANT_LOSE = 'CANT_LOSE',
  AT_RISK = 'AT_RISK',
  LOST = 'LOST',
}

registerEnumType(RfmGroupName, {
  name: 'RfmGroupName',
  description:
    'A group of customers by how recently and how often they buy (ANL-04, ADR-887): recent, ' +
    'slipping or lapsed, by one delivered order or none, two or three, or four or more.',
});

export enum RfmRecency {
  RECENT = 'RECENT',
  SLIPPING = 'SLIPPING',
  LAPSED = 'LAPSED',
}

registerEnumType(RfmRecency, {
  name: 'RfmRecency',
  description:
    'RECENT: last ordered within recentDays; LAPSED: lapsedDays ago or more; SLIPPING: between.',
});

export enum RfmFrequency {
  ONCE = 'ONCE',
  FEW = 'FEW',
  MANY = 'MANY',
}

registerEnumType(RfmFrequency, {
  name: 'RfmFrequency',
  description: 'Delivered orders: ONCE, one or none yet; FEW, two or three; MANY, four or more.',
});

@ObjectType({ description: 'Customers of one cell of the grid, and what they spent.' })
export class RfmGroup {
  @Field(() => RfmGroupName)
  name!: RfmGroupName;

  @Field(() => RfmRecency)
  recency!: RfmRecency;

  @Field(() => RfmFrequency)
  frequency!: RfmFrequency;

  @Field(() => Int)
  customers!: number;

  @Field(() => Money, {
    description: 'What they paid together on orders not cancelled, less refunds.',
  })
  amountSpent!: Money;

  @Field(() => Float, {
    nullable: true,
    description: 'Their delivered orders on average, to one place; null without customers.',
  })
  averageOrders!: number | null;

  @Field({
    description:
      "The segment query that finds them, for segmentCreate: the counts here are the segment's.",
  })
  query!: string;
}

@ObjectType({
  description:
    'Customers by how recently and how often they buy (ANL-04, ADR-887): RFM on a grid of ' +
    'three by three, worked out from the orders when asked.',
})
export class CustomerRfm {
  @Field(() => Int)
  recentDays!: number;

  @Field(() => Int)
  lapsedDays!: number;

  @Field(() => Int, { description: 'Customers who have ordered, in a group each.' })
  customers!: number;

  @Field(() => [RfmGroup], { description: 'Recent first, the most orders first in each.' })
  groups!: RfmGroup[];
}

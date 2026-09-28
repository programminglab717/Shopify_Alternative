import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Customer } from './customer.types.js';

export enum SegmentFilterType {
  NUMBER = 'NUMBER',
  MONEY = 'MONEY',
  DATE = 'DATE',
  TEXT = 'TEXT',
  TEXT_LIST = 'TEXT_LIST',
  BOOLEAN = 'BOOLEAN',
}

registerEnumType(SegmentFilterType, {
  name: 'SegmentFilterType',
  description: 'What a segment field holds, which decides the conditions it takes.',
  valuesMap: {
    NUMBER: { description: 'A whole number: number_of_orders >= 2.' },
    MONEY: { description: "An amount in the shop's currency: amount_spent > 5000." },
    DATE: {
      description:
        'A day in Pakistan time: last_order_date > 2026-09-01, or last_order_date < -60d for ' +
        'more than 60 days ago (d, w, m or y; also today and yesterday).',
    },
    TEXT: { description: "Text, ignoring case: city IN (Lahore, 'Rahim Yar Khan')." },
    TEXT_LIST: { description: "A list of text: customer_tags CONTAINS 'wholesale'." },
    BOOLEAN: { description: 'True or false: blocked = false.' },
  },
});

@ObjectType({ description: 'A field segment queries can use.' })
export class SegmentFilter {
  @Field({ description: 'As written in queries, e.g. "number_of_orders".' })
  name!: string;

  @Field(() => SegmentFilterType)
  type!: SegmentFilterType;

  @Field()
  description!: string;

  @Field({ description: 'A condition using it.' })
  example!: string;

  @Field(() => [String], { description: 'The operators it takes, e.g. ">=", "IN", "CONTAINS".' })
  operators!: string[];
}

@ObjectType({
  description:
    'A saved customer filter, e.g. "Lahore · bought 2+ times · no order in 60 days". Its members ' +
    'are the customers who match it now.',
})
export class Segment {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({
    description:
      'Conditions on segment fields (see segmentFilters) joined with AND, OR, NOT and ' +
      'parentheses: number_of_orders >= 2 AND last_order_date < -60d.',
  })
  query!: string;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class SegmentEdge {
  @Field()
  cursor!: string;

  @Field(() => Segment)
  node!: Segment;
}

@ObjectType()
export class SegmentConnection {
  @Field(() => [SegmentEdge])
  edges!: SegmentEdge[];

  @Field(() => [Segment])
  nodes!: Segment[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class SegmentsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ObjectType({ description: 'What a query matches now, before it is saved as a segment.' })
export class SegmentPreview {
  @Field(() => Int)
  memberCount!: number;

  @Field(() => [Customer], { description: 'The newest members first.' })
  members!: Customer[];
}

@ObjectType()
export class SegmentCreatePayload {
  @Field(() => Segment, { nullable: true })
  segment!: Segment | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SegmentUpdatePayload {
  @Field(() => Segment, { nullable: true })
  segment!: Segment | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SegmentDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSegmentId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

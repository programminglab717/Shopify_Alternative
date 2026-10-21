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
import { Order, Return, ReturnReason } from './order.types.js';

export enum ReturnRequestStatus {
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
}

registerEnumType(ReturnRequestStatus, {
  name: 'ReturnRequestStatus',
  description: 'Where a return a shopper asked for stands (ADR-675).',
  valuesMap: {
    REQUESTED: { description: 'Waiting for staff to approve or decline it.' },
    APPROVED: { description: 'Approved: it became a return.' },
    DECLINED: { description: 'Declined, saying why, as the shopper was told.' },
  },
});

export enum ReturnPreference {
  EXCHANGE = 'EXCHANGE',
  STORE_CREDIT = 'STORE_CREDIT',
  REFUND = 'REFUND',
}

registerEnumType(ReturnPreference, {
  name: 'ReturnPreference',
  description: 'What a shopper would like for what they send back (ADR-675).',
  valuesMap: {
    EXCHANGE: { description: 'Another size, or another item.' },
    STORE_CREDIT: { description: 'Store credit to spend with the shop.' },
    REFUND: { description: 'Their money back.' },
  },
});

@ObjectType({
  description: 'Units of one of the order’s lines a shopper asked to send back, and why.',
})
export class ReturnRequestLineItem {
  @Field(() => ID, { description: 'The line item (LineItem) ID.' })
  lineItemId!: string;

  @Field()
  title!: string;

  @Field()
  variantTitle!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => ReturnReason)
  returnReason!: ReturnReason;
}

@ObjectType({
  description:
    "A return a shopper asked for from their delivered order's page (ORD-08, ADR-675), within " +
    'the days the shop takes returns: staff approve it, and it becomes a return, or decline it.',
})
export class ReturnRequest {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'Its order (Order) ID.' })
  orderId!: string;

  @Field({ description: "Its order's name, such as #1001." })
  orderName!: string;

  @Field(() => ReturnRequestStatus)
  status!: ReturnRequestStatus;

  @Field(() => ReturnPreference)
  preference!: ReturnPreference;

  @Field({ description: "The shopper's own words; empty once their data was erased." })
  note!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Why it was declined, as the shopper was told.',
  })
  declineReason!: string | null;

  @Field(() => ID, { nullable: true, description: 'The return (Return) it became, once approved.' })
  returnId!: string | null;

  @Field(() => [ReturnRequestLineItem])
  lineItems!: ReturnRequestLineItem[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  decidedAt!: Date | null;
}

@ObjectType()
export class ReturnRequestEdge {
  @Field(() => ReturnRequest)
  node!: ReturnRequest;

  @Field()
  cursor!: string;
}

@ObjectType()
export class ReturnRequestConnection {
  @Field(() => [ReturnRequestEdge])
  edges!: ReturnRequestEdge[];

  @Field(() => [ReturnRequest])
  nodes!: ReturnRequest[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ReturnRequestsArgs {
  @Field(() => ReturnRequestStatus, {
    nullable: true,
    description: 'Those of one status, as REQUESTED for those waiting; all if left out.',
  })
  status?: ReturnRequestStatus | null;

  @Field(() => ID, { nullable: true, description: "One order's alone." })
  orderId?: string | null;

  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@ObjectType()
export class ReturnRequestApprovePayload {
  @Field(() => ReturnRequest, { nullable: true })
  returnRequest!: ReturnRequest | null;

  @Field(() => Return, { nullable: true, description: 'The return it became.' })
  return!: Return | null;

  @Field(() => Order, { nullable: true })
  order!: Order | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ReturnRequestDeclinePayload {
  @Field(() => ReturnRequest, { nullable: true })
  returnRequest!: ReturnRequest | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

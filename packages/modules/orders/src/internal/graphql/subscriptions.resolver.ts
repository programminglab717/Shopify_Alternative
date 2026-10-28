import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  SubscriptionService,
  intervalText,
  type SubscriptionChange as SubscriptionChangeValue,
  type SubscriptionRecord,
} from '../subscriptions.js';

export enum OrderSubscriptionStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(OrderSubscriptionStatus, { name: 'OrderSubscriptionStatus' });

export enum OrderSubscriptionChange {
  SKIP = 'SKIP',
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  CANCEL = 'CANCEL',
}

registerEnumType(OrderSubscriptionChange, {
  name: 'OrderSubscriptionChange',
  description:
    'SKIP its next order, the one after placed an interval later; PAUSE it, no orders placed ' +
    'until RESUME; or CANCEL it, for good.',
});

@ObjectType()
export class OrderSubscriptionLine {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Int)
  quantity!: number;
}

@ObjectType({
  description:
    "A customer's subscription (CAT-16, ADR-862): an order placed again each interval, the same " +
    "items to the same address at its plan's price, by cash on delivery, each confirmed with " +
    'the customer as any other.',
})
export class OrderSubscription {
  @Field(() => ID)
  id!: string;

  @Field(() => OrderSubscriptionStatus)
  status!: OrderSubscriptionStatus;

  @Field({ description: 'Its plan\'s name as it was when they subscribed: "Every month".' })
  planName!: string;

  @Field({ description: '"Every month", "Every 2 weeks".' })
  interval!: string;

  @Field(() => Int)
  discountPercent!: number;

  @Field({ description: "The day its next order is placed, YYYY-MM-DD in Pakistan's time." })
  nextOrderOn!: string;

  @Field(() => Int, { description: 'Its orders so far, the first among them.' })
  ordersPlaced!: number;

  @Field(() => ID)
  customerId!: string;

  @Field(() => String, { nullable: true, description: 'Who it goes to; null once erased.' })
  name!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => ID)
  originOrderId!: string;

  @Field(() => ID, { nullable: true })
  lastOrderId!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "Why its last due order couldn't be placed; tried each day, skipped after three.",
  })
  lastError!: string | null;

  @Field(() => [OrderSubscriptionLine])
  lines!: OrderSubscriptionLine[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class OrderSubscriptionPayload {
  @Field(() => OrderSubscription, { nullable: true })
  subscription!: OrderSubscription | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toSubscription = (record: SubscriptionRecord) =>
  Object.assign(new OrderSubscription(), {
    id: toPublicId('orderSubscription', record.id),
    status: record.status.toUpperCase() as OrderSubscriptionStatus,
    planName: record.planName,
    interval: intervalText(record.intervalUnit, record.intervalCount),
    discountPercent: record.discountPercent,
    nextOrderOn: record.nextOrderOn,
    ordersPlaced: record.ordersPlaced,
    customerId: toPublicId('customer', record.customerId),
    name: record.shippingAddress.name,
    city: record.shippingAddress.city,
    originOrderId: toPublicId('order', record.originOrderId),
    lastOrderId: record.lastOrderId && toPublicId('order', record.lastOrderId),
    lastError: record.lastError,
    lines: record.lines.map((line) => ({
      variantId: toPublicId('variant', line.variantId),
      quantity: line.quantity,
    })),
    createdAt: record.createdAt,
  });

/** Customers' subscriptions (ADR-862), for staff who see and write orders. */
@Resolver(() => OrderSubscription)
export class SubscriptionResolver {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Query(() => [OrderSubscription], {
    description: "The shop's subscriptions, the latest first (50 unless given, 100 at most).",
  })
  @RequireScopes('read_orders')
  async orderSubscriptions(
    @CurrentTenant() tenant: TenantContext,
    @Args('status', { type: () => OrderSubscriptionStatus, nullable: true })
    status?: OrderSubscriptionStatus | null,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
  ): Promise<OrderSubscription[]> {
    const records = await this.subscriptions.list(tenant, {
      status: status ? (status.toLowerCase() as SubscriptionRecord['status']) : null,
      first: first ?? 50,
    });
    return records.map(toSubscription);
  }

  @Mutation(() => OrderSubscriptionPayload, {
    description: "Skips a subscription's next order, pauses, resumes or cancels it.",
  })
  @RequireScopes('write_orders')
  async orderSubscriptionChange(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('change', { type: () => OrderSubscriptionChange }) change: OrderSubscriptionChange,
  ): Promise<OrderSubscriptionPayload> {
    const uuid = tryFromPublicId(id, 'orderSubscription');
    const result = uuid
      ? await this.subscriptions.change(
          tenant,
          uuid,
          change.toLowerCase() as SubscriptionChangeValue,
        )
      : failOne<SubscriptionRecord>(['id'], 'NOT_FOUND', 'No subscription of the shop has this ID');
    return Object.assign(new OrderSubscriptionPayload(), {
      subscription: result.ok ? toSubscription(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

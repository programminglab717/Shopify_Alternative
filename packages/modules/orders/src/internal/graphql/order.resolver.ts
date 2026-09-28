import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import {
  Customer,
  CustomerService,
  toCustomer,
  type CustomerRecord,
} from '@hatti/customers/public';
import {
  Location,
  LocationService,
  toLocation,
  type LocationRecord,
} from '@hatti/inventory/public';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { OrderService } from '../order.service.js';
import type { OrderRecord } from '../records.js';
import { ORDER_STAGES } from '../schema.js';
import {
  cursorAfter,
  toCancelReasonValue,
  toOrder,
  toOrderConnection,
  toOrderEventConnection,
  toPaymentMethodValue,
  toRiskLevelValue,
  toStageValue,
  uuidOf,
} from './mappers.js';
import {
  Order,
  OrderCancelPayload,
  OrderCancelReason,
  OrderConfirmPayload,
  OrderConnection,
  OrderCreateInput,
  OrderCreatePayload,
  OrderEventConnection,
  OrderEventsArgs,
  OrderMarkAsPaidPayload,
  OrderStage,
  OrderStageCount,
  OrderUpdateInput,
  OrderUpdatePayload,
  OrdersArgs,
} from './order.types.js';

type Payload = { order: Order | null; userErrors: UserError[] };

function payload<T extends Payload>(
  type: new () => T,
  result: MutationResult<OrderRecord>,
  tenant: TenantContext,
): T {
  return Object.assign(new type(), {
    order: result.ok ? toOrder(result.value, tenant) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

@Resolver(() => Order)
export class OrderResolver {
  constructor(
    private readonly service: OrderService,
    private readonly locations: LocationService,
    private readonly customers: CustomerService,
  ) {}

  @Query(() => Order, { nullable: true, description: 'An order by ID, or null if not found.' })
  @RequireScopes('read_orders')
  async order(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Order | null> {
    const record = await this.service.get(tenant, uuidOf('order', id));
    return record ? toOrder(record, tenant) : null;
  }

  @Query(() => OrderConnection, { description: 'Orders, newest first.' })
  @RequireScopes('read_orders')
  async orders(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: OrdersArgs,
  ): Promise<OrderConnection> {
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      query: args.query,
      stage: args.stage ? toStageValue(args.stage) : null,
      riskLevel: args.riskLevel ? toRiskLevelValue(args.riskLevel) : null,
    });
    return toOrderConnection(items, hasNextPage, tenant);
  }

  @Query(() => [OrderStageCount], { description: 'How many orders are at each stage.' })
  @RequireScopes('read_orders')
  async orderStageCounts(@CurrentTenant() tenant: TenantContext): Promise<OrderStageCount[]> {
    const counts = await this.service.stageCounts(tenant);
    return ORDER_STAGES.map((stage) =>
      Object.assign(new OrderStageCount(), {
        stage: stage.toUpperCase() as OrderStage,
        count: counts.get(stage) ?? 0,
      }),
    );
  }

  @ResolveField(() => Location, {
    nullable: true,
    description: 'Where it ships from, and where its stock was committed.',
  })
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<Location | null> {
    const loader = loaders.get<string, LocationRecord>('inventory.locations', (ids) =>
      this.locations.getMany(tenant, ids),
    );
    const record = await loader.load(order.locationId);
    return record ? toLocation(record) : null;
  }

  @ResolveField(() => Customer, {
    nullable: true,
    description: 'Whoever its mobile number belongs to.',
  })
  @RequireScopes('read_customers')
  async customer(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<Customer | null> {
    const loader = loaders.get<string, CustomerRecord>('customers.byId', (ids) =>
      this.customers.getMany(tenant, ids),
    );
    const record = await loader.load(order.customerId);
    return record ? toCustomer(record) : null;
  }

  @ResolveField(() => OrderEventConnection, { description: 'Its timeline, newest first.' })
  async events(
    @CurrentTenant() tenant: TenantContext,
    @Parent() order: Order,
    @Args() args: OrderEventsArgs,
  ): Promise<OrderEventConnection> {
    const { items, hasNextPage } = await this.service.timeline(tenant, order.uuid, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
    });
    return toOrderEventConnection(items, hasNextPage);
  }

  @Mutation(() => OrderCreatePayload, {
    description:
      'Places an order, e.g. one taken in a chat, and commits its stock at its location. Cash-on-' +
      'delivery orders wait for the customer to confirm, or for review if the number is blocked ' +
      "or the order's risk reaches the shop's threshold.",
  })
  @RequireScopes('write_orders')
  async orderCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: OrderCreateInput,
  ): Promise<OrderCreatePayload> {
    const result = await this.service.create(tenant, {
      ...input,
      paymentMethod: input.paymentMethod ? toPaymentMethodValue(input.paymentMethod) : null,
      locationId: input.locationId ? uuidOf('location', input.locationId) : null,
      lineItems: input.lineItems.map((line) => ({
        ...line,
        variantId: uuidOf('variant', line.variantId),
      })),
    });
    return payload(OrderCreatePayload, result, tenant);
  }

  @Mutation(() => OrderUpdatePayload, {
    description: 'Changes the shipping address (before anything ships), email, note or tags.',
  })
  @RequireScopes('write_orders')
  async orderUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: OrderUpdateInput,
  ): Promise<OrderUpdatePayload> {
    const result = await this.service.update(tenant, uuidOf('order', id), input);
    return payload(OrderUpdatePayload, result, tenant);
  }

  @Mutation(() => OrderConfirmPayload, {
    description: 'Records that the customer confirmed a cash-on-delivery order.',
  })
  @RequireScopes('write_orders')
  async orderConfirm(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderConfirmPayload> {
    const result = await this.service.confirm(tenant, uuidOf('order', id));
    return payload(OrderConfirmPayload, result, tenant);
  }

  @Mutation(() => OrderCancelPayload, {
    description: 'Cancels an order that has not shipped, and releases its stock.',
  })
  @RequireScopes('write_orders')
  async orderCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { type: () => OrderCancelReason }) reason: OrderCancelReason,
    @Args('staffNote', { type: () => String, nullable: true, description: 'For the timeline.' })
    staffNote?: string | null,
  ): Promise<OrderCancelPayload> {
    const result = await this.service.cancel(tenant, uuidOf('order', id), {
      reason: toCancelReasonValue(reason),
      staffNote,
    });
    return payload(OrderCancelPayload, result, tenant);
  }

  @Mutation(() => OrderMarkAsPaidPayload, {
    description:
      'Records that the order is paid in full: cash collected at the door, or a transfer received.',
  })
  @RequireScopes('write_orders')
  async orderMarkAsPaid(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderMarkAsPaidPayload> {
    const result = await this.service.markAsPaid(tenant, uuidOf('order', id));
    return payload(OrderMarkAsPaidPayload, result, tenant);
  }
}

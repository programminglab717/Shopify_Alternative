import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  deniedToRole,
  pageSize,
  phoneAccess,
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
import { OrderService, type BulkResult } from '../order.service.js';
import type { OrderAttributionRecord, OrderRecord } from '../records.js';
import { ORDER_STAGES } from '../schema.js';
import {
  cursorAfter,
  orderSearch,
  toCancelReasonValue,
  toCustomerJourneySummary,
  toOrder,
  toOrderConnection,
  toOrderEventConnection,
  toPaymentMethodValue,
  toRiskLevelValue,
  toStageValue,
  uuidOf,
} from './mappers.js';
import {
  CustomerJourneySummary,
  Order,
  OrderBulkPayload,
  OrderCancelPayload,
  OrderCancelReason,
  OrderConfirmPayload,
  OrderConnection,
  OrderCreateInput,
  OrderCreateManualPaymentPayload,
  OrderPayWithStoreCreditPayload,
  OrderCreatePayload,
  OrderEventConnection,
  OrderEventsArgs,
  OrderMarkAsPaidPayload,
  OrderLocationChangePayload,
  OrderMarkPackedPayload,
  OrderMarkUnpackedPayload,
  OrderPhoneRevealPayload,
  OrderStage,
  OrderStageCount,
  OrderUpdateInput,
  OrderUpdatePayload,
  OrdersArgs,
} from './order.types.js';

type Payload = { order: Order | null; userErrors: UserError[] };

function bulkPayload(result: MutationResult<BulkResult>, tenant: TenantContext): OrderBulkPayload {
  return Object.assign(new OrderBulkPayload(), {
    orders: result.ok ? result.value.orders.map((order) => toOrder(order, tenant)) : [],
    userErrors: UserError.list(result.ok ? result.value.errors : result.errors),
  });
}

/** Order IDs of a bulk action, as UUIDs; a malformed one is a BAD_USER_INPUT error. */
function orderIds(ids: readonly string[]): string[] {
  return ids.map((id) => uuidOf('order', id));
}

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
      query: orderSearch(args.query),
      stage: args.stage ? toStageValue(args.stage) : null,
      riskLevel: args.riskLevel ? toRiskLevelValue(args.riskLevel) : null,
      placedFrom: args.placedFrom,
      placedBefore: args.placedBefore,
      transferReceipt: args.hasTransferReceipt,
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
    // Hidden until the shop's plan has room for the order (ADR-263).
    if (order.overPlanLimit) return null;
    const loader = loaders.get<string, CustomerRecord>('customers.byId', (ids) =>
      this.customers.getMany(tenant, ids),
    );
    const record = await loader.load(order.customerId);
    return record ? toCustomer(record, tenant) : null;
  }

  @ResolveField(() => CustomerJourneySummary, {
    nullable: true,
    description:
      'How its customer came to the online store before placing it (ADR-139): their first ' +
      'visit and their last from elsewhere. Null for orders placed otherwise than through ' +
      'checkout, and for those the storefront knew no visit for.',
  })
  async customerJourneySummary(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<CustomerJourneySummary | null> {
    const loader = loaders.get<string, OrderAttributionRecord>('orders.attribution', (ids) =>
      this.service.attributionsOf(tenant, ids),
    );
    const record = await loader.load(order.uuid);
    return record ? toCustomerJourneySummary(record) : null;
  }

  @ResolveField(() => OrderEventConnection, {
    description:
      'Its timeline, newest first: what happened to it, and the comments staff and apps wrote ' +
      'on it.',
  })
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
      "or the order's risk reaches the shop's threshold. Needs an Idempotency-Key header.",
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
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

  @Mutation(() => OrderPhoneRevealPayload, {
    description:
      "The customer's number on an order in full, for staff who see it masked, such as a " +
      'confirmation agent about to call. Every reveal is logged. Roles that see numbers masked ' +
      'without a reveal, such as packers, are denied.',
  })
  @RequireScopes('read_orders')
  async orderPhoneReveal(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderPhoneRevealPayload> {
    if (phoneAccess(tenant) === 'masked') {
      throw deniedToRole("Access denied. This role sees customers' numbers masked.");
    }
    const result = await this.service.revealPhone(tenant, uuidOf('order', id));
    return Object.assign(new OrderPhoneRevealPayload(), {
      phone: result.ok ? result.value : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => OrderMarkPackedPayload, {
    description:
      'Marks a confirmed or paid order as packed, moving it from TO_PACK to TO_BOOK. Shipping ' +
      'does not need it; it is for shops that pack and book in separate steps.',
  })
  @RequireScopes('write_orders')
  async orderMarkPacked(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderMarkPackedPayload> {
    const result = await this.service.markPacked(tenant, uuidOf('order', id));
    return payload(OrderMarkPackedPayload, result, tenant);
  }

  @Mutation(() => OrderMarkUnpackedPayload, {
    description: 'Takes back a packed mark while nothing has shipped: back to TO_PACK.',
  })
  @RequireScopes('write_orders')
  async orderMarkUnpacked(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OrderMarkUnpackedPayload> {
    const result = await this.service.markUnpacked(tenant, uuidOf('order', id));
    return payload(OrderMarkUnpackedPayload, result, tenant);
  }

  @Mutation(() => OrderLocationChangePayload, {
    description:
      'Ships the order from another active location: its stock committed there and let go where ' +
      'it was, refused if that location is short. Only before it is packed or anything has shipped.',
  })
  @RequireScopes('write_orders')
  async orderLocationChange(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('locationId', { type: () => ID }) locationId: string,
  ): Promise<OrderLocationChangePayload> {
    const result = await this.service.changeLocation(
      tenant,
      uuidOf('order', id),
      uuidOf('location', locationId),
    );
    return payload(OrderLocationChangePayload, result, tenant);
  }

  @Mutation(() => OrderBulkPayload, {
    description: 'Confirms up to 250 orders, as orderConfirm does each.',
  })
  @RequireScopes('write_orders')
  async orderBulkConfirm(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
  ): Promise<OrderBulkPayload> {
    return bulkPayload(await this.service.bulkConfirm(tenant, orderIds(ids)), tenant);
  }

  @Mutation(() => OrderBulkPayload, {
    description: 'Cancels up to 250 orders for one reason, as orderCancel does each.',
  })
  @RequireScopes('write_orders')
  async orderBulkCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('reason', { type: () => OrderCancelReason }) reason: OrderCancelReason,
    @Args('staffNote', { type: () => String, nullable: true, description: 'For each timeline.' })
    staffNote?: string | null,
  ): Promise<OrderBulkPayload> {
    const result = await this.service.bulkCancel(tenant, orderIds(ids), {
      reason: toCancelReasonValue(reason),
      staffNote,
    });
    return bulkPayload(result, tenant);
  }

  @Mutation(() => OrderBulkPayload, {
    description: 'Marks up to 250 orders packed, as orderMarkPacked does each.',
  })
  @RequireScopes('write_orders')
  async orderBulkMarkPacked(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
  ): Promise<OrderBulkPayload> {
    return bulkPayload(await this.service.bulkMarkPacked(tenant, orderIds(ids)), tenant);
  }

  @Mutation(() => OrderBulkPayload, {
    description:
      'Adds tags to up to 250 orders. Tags an order has already, in any case, stay as they are.',
  })
  @RequireScopes('write_orders')
  async orderBulkAddTags(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('tags', { type: () => [String] }) tags: string[],
  ): Promise<OrderBulkPayload> {
    return bulkPayload(await this.service.bulkAddTags(tenant, orderIds(ids), tags), tenant);
  }

  @Mutation(() => OrderBulkPayload, {
    description: 'Removes tags from up to 250 orders, ignoring case.',
  })
  @RequireScopes('write_orders')
  async orderBulkRemoveTags(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('tags', { type: () => [String] }) tags: string[],
  ): Promise<OrderBulkPayload> {
    return bulkPayload(await this.service.bulkRemoveTags(tenant, orderIds(ids), tags), tenant);
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

  @Mutation(() => OrderCreateManualPaymentPayload, {
    description:
      "Records money received for the order, as Shopify's orderCreateManualPayment does: " +
      'amount, in the shop currency, or what it waits for by transfer (its advance, or the rest ' +
      'of its total), else the rest. An order waiting for its advance or transfer moves on once ' +
      'that is in.',
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
  async orderCreateManualPayment(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('amount', { type: () => String, nullable: true, description: '"500".' })
    amount: string | null,
  ): Promise<OrderCreateManualPaymentPayload> {
    const result = await this.service.recordPayment(tenant, uuidOf('order', id), { amount });
    return payload(OrderCreateManualPaymentPayload, result, tenant);
  }

  @Mutation(() => OrderPayWithStoreCreditPayload, {
    description:
      "Pays the order, or part of it, with its customer's store credit (ORD-09, ADR-185): " +
      'amount, in the shop currency, or as much as it owes and the credit covers, the credits ' +
      'that expire soonest first. While it is open and nothing of it has shipped; paying on ' +
      'delivery, an advance still owed is paid first, and the cash at the door drops by the ' +
      'rest. Cancelled, the order gives the credit back. Needs write_orders and ' +
      'write_store_credit_account_transactions, and an Idempotency-Key header.',
  })
  @RequireScopes('write_orders', 'write_store_credit_account_transactions')
  @RequireIdempotencyKey()
  async orderPayWithStoreCredit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('amount', { type: () => String, nullable: true, description: '"500".' })
    amount: string | null,
  ): Promise<OrderPayWithStoreCreditPayload> {
    const result = await this.service.payWithStoreCredit(tenant, uuidOf('order', id), { amount });
    return payload(OrderPayWithStoreCreditPayload, result, tenant);
  }
}

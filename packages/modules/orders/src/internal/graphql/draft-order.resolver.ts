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
  Location,
  LocationService,
  toLocation,
  type LocationRecord,
} from '@hatti/inventory/public';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  DraftOrderService,
  type DraftOrderInput as DraftOrderFields,
} from '../draft-order.service.js';
import { OrderService } from '../order.service.js';
import type { DraftOrderRecord, OrderRecord } from '../records.js';
import {
  DraftOrder,
  DraftOrderCompletePayload,
  DraftOrderConnection,
  DraftOrderCreatePayload,
  DraftOrderDeletePayload,
  DraftOrderInput,
  DraftOrderLinkCreatePayload,
  DraftOrderUpdatePayload,
  DraftOrdersArgs,
} from './draft-order.types.js';
import {
  cursorAfter,
  toDraftOrder,
  toDraftOrderConnection,
  toDraftSourceValue,
  toDraftStatusValue,
  toOrder,
  toPaymentMethodValue,
  uuidOf,
} from './mappers.js';
import { Order } from './order.types.js';

type Payload = { draftOrder: DraftOrder | null; userErrors: UserError[] };

function payload<T extends Payload>(
  type: new () => T,
  result: MutationResult<DraftOrderRecord>,
  tenant: TenantContext,
): T {
  return Object.assign(new type(), {
    draftOrder: result.ok ? toDraftOrder(result.value, tenant) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** The input as the service takes it: IDs as UUIDs, enums as stored values. */
function fields(input: DraftOrderInput): DraftOrderFields {
  return {
    ...input,
    lineItems: input.lineItems?.map((line) => ({
      ...line,
      variantId: uuidOf('variant', line.variantId),
    })),
    source: input.source ? toDraftSourceValue(input.source) : input.source,
    paymentMethod: input.paymentMethod
      ? toPaymentMethodValue(input.paymentMethod)
      : input.paymentMethod,
    locationId: input.locationId ? uuidOf('location', input.locationId) : input.locationId,
  };
}

@Resolver(() => DraftOrder)
export class DraftOrderResolver {
  constructor(
    private readonly drafts: DraftOrderService,
    private readonly orders: OrderService,
    private readonly locations: LocationService,
  ) {}

  @Query(() => DraftOrder, { nullable: true, description: 'A draft order by ID, or null.' })
  @RequireScopes('read_orders')
  async draftOrder(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DraftOrder | null> {
    const record = await this.drafts.get(tenant, uuidOf('draftOrder', id));
    return record ? toDraftOrder(record, tenant) : null;
  }

  @Query(() => DraftOrderConnection, { description: 'Draft orders, newest first.' })
  @RequireScopes('read_orders')
  async draftOrders(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: DraftOrdersArgs,
  ): Promise<DraftOrderConnection> {
    const { items, hasNextPage } = await this.drafts.list(tenant, {
      first: pageSize(args.first),
      after: cursorAfter(args.after),
      status: args.status ? toDraftStatusValue(args.status) : null,
    });
    return toDraftOrderConnection(items, hasNextPage, tenant);
  }

  @ResolveField(() => Order, {
    nullable: true,
    description: 'The order it became, once completed.',
  })
  async order(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() draft: DraftOrder,
  ): Promise<Order | null> {
    if (!draft.orderId) return null;
    const loader = loaders.get<string, OrderRecord>('orders.byId', (ids) =>
      this.orders.getMany(tenant, ids),
    );
    const record = await loader.load(draft.orderId);
    return record ? toOrder(record, tenant) : null;
  }

  @ResolveField(() => Location, {
    nullable: true,
    description: 'Where the order will ship from; null for the primary location when it is placed.',
  })
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() draft: DraftOrder,
  ): Promise<Location | null> {
    if (!draft.locationId) return null;
    const loader = loaders.get<string, LocationRecord>('inventory.locations', (ids) =>
      this.locations.getMany(tenant, ids),
    );
    const record = await loader.load(draft.locationId);
    return record ? toLocation(record) : null;
  }

  @Mutation(() => DraftOrderCreatePayload, {
    description:
      'Starts a draft order, e.g. while a customer picks items in a chat. Its lines keep the ' +
      "prices they are given, or else the variants' prices now. It holds no stock.",
  })
  @RequireScopes('write_orders')
  async draftOrderCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: DraftOrderInput,
  ): Promise<DraftOrderCreatePayload> {
    return payload(
      DraftOrderCreatePayload,
      await this.drafts.create(tenant, fields(input)),
      tenant,
    );
  }

  @Mutation(() => DraftOrderUpdatePayload, {
    description:
      'Changes an open draft: only the fields given. A draft that becomes prepaid, or loses its ' +
      'address, loses its link.',
  })
  @RequireScopes('write_orders')
  async draftOrderUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: DraftOrderInput,
  ): Promise<DraftOrderUpdatePayload> {
    const result = await this.drafts.update(tenant, uuidOf('draftOrder', id), fields(input));
    return payload(DraftOrderUpdatePayload, result, tenant);
  }

  @Mutation(() => DraftOrderDeletePayload, {
    description: 'Deletes an open draft, and its link with it.',
  })
  @RequireScopes('write_orders')
  async draftOrderDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DraftOrderDeletePayload> {
    const result = await this.drafts.delete(tenant, uuidOf('draftOrder', id));
    return Object.assign(new DraftOrderDeletePayload(), {
      deletedId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DraftOrderCompletePayload, {
    description:
      'Places the draft as an order at its prices and commits its stock, as orderCreate does: ' +
      'for when the customer agreed in the chat, or paid in advance. A cash-on-delivery order ' +
      'then waits for them to confirm. Completing a completed draft changes nothing.',
  })
  @RequireScopes('write_orders')
  async draftOrderComplete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DraftOrderCompletePayload> {
    const result = await this.drafts.complete(tenant, uuidOf('draftOrder', id));
    return payload(DraftOrderCompletePayload, result, tenant);
  }

  @Mutation(() => DraftOrderLinkCreatePayload, {
    description:
      'A link where the customer sees a cash-on-delivery draft, adds or corrects its address ' +
      '(with their number, while the draft has none), and confirms it: the draft then becomes ' +
      'an order the customer confirmed, unless the number is blocked or the order risky, which ' +
      'waits for review. A new link replaces the one before.',
  })
  @RequireScopes('write_orders')
  async draftOrderLinkCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('expiresInHours', {
      type: () => Int,
      nullable: true,
      description: 'How long it works: 1 to 720 hours; default 72.',
    })
    expiresInHours?: number | null,
  ): Promise<DraftOrderLinkCreatePayload> {
    const result = await this.drafts.createLink(tenant, uuidOf('draftOrder', id), {
      expiresInHours,
    });
    return Object.assign(new DraftOrderLinkCreatePayload(), {
      draftOrder: result.ok ? toDraftOrder(result.value.draftOrder, tenant) : null,
      url: result.ok ? result.value.url : null,
      whatsappUrl: result.ok ? result.value.whatsappUrl : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

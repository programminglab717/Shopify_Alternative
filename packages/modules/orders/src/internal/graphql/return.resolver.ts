import {
  CurrentTenant,
  Loaders,
  PageInfo,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  badUserInput,
  decodeTimeCursor,
  encodeCursor,
  pageSize,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import {
  Location,
  LocationService,
  toLocation,
  type LocationRecord,
} from '@hatti/inventory/public';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ReturnService, type OpenReturnRecord, type ReturnResult } from '../return.service.js';
import { orderName, returnName } from '../rules.js';
import type { ReturnReasonValue } from '../schema.js';
import { toOrder, uuidOf } from './mappers.js';
import {
  OpenReturn,
  OpenReturnConnection,
  OpenReturnEdge,
  OpenReturnsArgs,
  Return,
  ReturnCancelPayload,
  ReturnCreateInput,
  ReturnCreatePayload,
  ReturnReceivePayload,
  ReturnRestockInput,
  TrackingInfo,
} from './order.types.js';

type ReturnPayloadType =
  typeof ReturnCreatePayload | typeof ReturnReceivePayload | typeof ReturnCancelPayload;

/** A mutation's answer: the return it changed, with its order, or what was wrong. */
function payload<T extends ReturnPayloadType>(
  type: T,
  result: MutationResult<ReturnResult>,
  tenant: TenantContext,
): InstanceType<T> {
  if (!result.ok) {
    return Object.assign(new type(), {
      return: null,
      order: null,
      userErrors: UserError.list(result.errors),
    }) as InstanceType<T>;
  }
  const order = toOrder(result.value.order, tenant);
  const id = toPublicId('return', result.value.return.id);
  return Object.assign(new type(), {
    return: order.returns.find((each) => each.id === id) ?? null,
    order,
    userErrors: [],
  }) as InstanceType<T>;
}

/**
 * Customer returns (ORD-07, ADR-136): items of a delivered parcel sent back, recorded by staff and
 * checked in as they arrive.
 */
@Resolver(() => Return)
export class ReturnResolver {
  constructor(
    private readonly returns: ReturnService,
    private readonly locations: LocationService,
  ) {}

  @ResolveField(() => Location, {
    nullable: true,
    description: 'Where it comes back to, and goes back in stock.',
  })
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() back: Return,
  ): Promise<Location | null> {
    const loader = loaders.get<string, LocationRecord>('inventory.locations', (ids) =>
      this.locations.getMany(tenant, ids),
    );
    const record = await loader.load(back.locationId);
    return record ? toLocation(record) : null;
  }

  @Query(() => OpenReturnConnection, {
    description:
      'Customer returns still on their way, the longest first, with how many days each has ' +
      'been and the items coming back: those to chase (ADR-138).',
  })
  @RequireScopes('read_orders')
  async openReturns(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: OpenReturnsArgs,
  ): Promise<OpenReturnConnection> {
    let after: { id: string; at: string } | null = null;
    if (args.after) {
      after = decodeTimeCursor(args.after);
      if (!isUuid(after.id)) throw badUserInput('Invalid cursor');
    }
    const { items, hasNextPage } = await this.returns.open(tenant, {
      first: pageSize(args.first),
      after: after && { id: after.id, createdAt: after.at },
    });
    const edges = items.map((record) =>
      Object.assign(new OpenReturnEdge(), {
        node: toOpenReturn(record),
        cursor: encodeCursor({ id: record.id, at: record.createdAtExactly }),
      }),
    );
    return Object.assign(new OpenReturnConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Mutation(() => ReturnCreatePayload, {
    description:
      'Records a customer sending back items of a delivered parcel, as when a size is wrong ' +
      '(ADR-136): units of its lines, each no more than were delivered and are not coming back ' +
      "already, with why. It comes back to the location given, or the order's, and is checked " +
      'in with returnReceive. A refused parcel comes back as itself, with ' +
      'fulfillmentReceiveReturn; money given back is a refund, with orderRefund.',
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
  async returnCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ReturnCreateInput,
  ): Promise<ReturnCreatePayload> {
    const result = await this.returns.create(tenant, {
      orderId: uuidOf('order', input.orderId),
      returnLineItems: input.returnLineItems.map((line) => ({
        lineItemId: uuidOf('lineItem', line.lineItemId),
        quantity: line.quantity,
        reason: line.returnReason.toLowerCase() as ReturnReasonValue,
      })),
      locationId: input.locationId ? uuidOf('location', input.locationId) : null,
      trackingCompany: input.trackingInfo?.company,
      trackingNumber: input.trackingInfo?.number,
      note: input.note,
      exchangeLineItems: input.exchangeLineItems?.map((line) => ({
        ...line,
        variantId: uuidOf('variant', line.variantId),
      })),
      exchangeShippingPrice: input.exchangeShippingPrice,
    });
    return payload(ReturnCreatePayload, result, tenant);
  }

  @Mutation(() => ReturnReceivePayload, {
    description:
      'Checks a return in as it arrives: `restock` says how many of each line go back in stock ' +
      'where it came back to; the rest are written off. Everything is restocked if left out.',
  })
  @RequireScopes('write_orders')
  async returnReceive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('restock', { type: () => [ReturnRestockInput], nullable: true })
    restock?: ReturnRestockInput[] | null,
  ): Promise<ReturnReceivePayload> {
    const result = await this.returns.receive(
      tenant,
      uuidOf('return', id),
      restock?.map((entry) => ({
        lineItemId: uuidOf('lineItem', entry.lineItemId),
        quantity: entry.quantity,
      })),
    );
    return payload(ReturnReceivePayload, result, tenant);
  }

  @Mutation(() => ReturnCancelPayload, {
    description:
      'Cancels a return still on its way back, as when its customer keeps the items after all.',
  })
  @RequireScopes('write_orders')
  async returnCancel(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ReturnCancelPayload> {
    return payload(
      ReturnCancelPayload,
      await this.returns.cancel(tenant, uuidOf('return', id)),
      tenant,
    );
  }
}

function toOpenReturn(record: OpenReturnRecord): OpenReturn {
  return Object.assign(new OpenReturn(), {
    id: toPublicId('return', record.id),
    name: returnName(record.orderNumber, record.number),
    orderId: toPublicId('order', record.orderId),
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: null,
    }),
    exchangeOrderName:
      record.exchangeOrderNumber === null ? null : orderName(record.exchangeOrderNumber),
    createdAt: record.createdAt,
    days: record.days,
    units: record.units,
  });
}

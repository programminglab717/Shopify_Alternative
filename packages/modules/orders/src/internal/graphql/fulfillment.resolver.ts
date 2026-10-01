import {
  CurrentTenant,
  Loaders,
  PageInfo,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
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
import {
  FulfillmentService,
  type ParcelResult,
  type ReturningParcelRecord,
} from '../fulfillment.service.js';
import { orderName } from '../rules.js';
import { toOrder, uuidOf } from './mappers.js';
import {
  Fulfillment,
  FulfillmentMarkDeliveredPayload,
  FulfillmentMarkReturningPayload,
  FulfillmentReceiveReturnPayload,
  FulfillmentRestockInput,
  FulfillmentTrackingInfoUpdatePayload,
  FulfillmentTrackingInput,
  Order,
  OrderFulfillInput,
  OrderFulfillPayload,
  ReturningParcel,
  ReturningParcelConnection,
  ReturningParcelEdge,
  ReturningParcelsArgs,
  TrackingInfo,
} from './order.types.js';

type Payload = { fulfillment: Fulfillment | null; order: Order | null; userErrors: UserError[] };

function payload<T extends Payload>(
  type: new () => T,
  result: MutationResult<ParcelResult>,
  tenant: TenantContext,
): T {
  if (!result.ok) {
    return Object.assign(new type(), {
      fulfillment: null,
      order: null,
      userErrors: UserError.list(result.errors),
    });
  }
  const order = toOrder(result.value.order, tenant);
  const id = toPublicId('fulfillment', result.value.fulfillmentId);
  return Object.assign(new type(), {
    fulfillment: order.fulfillments.find((parcel) => parcel.id === id) ?? null,
    order,
    userErrors: [],
  });
}

@Resolver(() => Fulfillment)
export class FulfillmentResolver {
  constructor(
    private readonly service: FulfillmentService,
    private readonly locations: LocationService,
  ) {}

  @ResolveField(() => Location, { nullable: true, description: 'Where it shipped from.' })
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() parcel: Fulfillment,
  ): Promise<Location | null> {
    const loader = loaders.get<string, LocationRecord>('inventory.locations', (ids) =>
      this.locations.getMany(tenant, ids),
    );
    const record = await loader.load(parcel.locationId);
    return record ? toLocation(record) : null;
  }

  @Mutation(() => OrderFulfillPayload, {
    description:
      'Ships items of a confirmed or prepaid order in one parcel, taking them out of stock. ' +
      'Needs an Idempotency-Key header.',
  })
  @RequireScopes('write_orders')
  @RequireIdempotencyKey()
  async orderFulfill(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => OrderFulfillInput, nullable: true })
    input?: OrderFulfillInput | null,
  ): Promise<OrderFulfillPayload> {
    const result = await this.service.fulfill(tenant, uuidOf('order', id), {
      lineItems: input?.lineItems?.map((line) => ({
        id: uuidOf('lineItem', line.id),
        quantity: line.quantity,
      })),
      tracking: input?.trackingInfo,
    });
    return payload(OrderFulfillPayload, result, tenant);
  }

  @Mutation(() => FulfillmentTrackingInfoUpdatePayload, {
    description: "Sets a parcel's courier, tracking number and link, e.g. once it is booked.",
  })
  @RequireScopes('write_orders')
  async fulfillmentTrackingInfoUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('trackingInfo', { type: () => FulfillmentTrackingInput })
    trackingInfo: FulfillmentTrackingInput,
  ): Promise<FulfillmentTrackingInfoUpdatePayload> {
    const result = await this.service.updateTracking(
      tenant,
      uuidOf('fulfillment', id),
      trackingInfo,
    );
    return payload(FulfillmentTrackingInfoUpdatePayload, result, tenant);
  }

  @Mutation(() => FulfillmentMarkDeliveredPayload, {
    description: 'The courier delivered the parcel.',
  })
  @RequireScopes('write_orders')
  async fulfillmentMarkDelivered(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FulfillmentMarkDeliveredPayload> {
    const result = await this.service.markDelivered(tenant, uuidOf('fulfillment', id));
    return payload(FulfillmentMarkDeliveredPayload, result, tenant);
  }

  @Mutation(() => FulfillmentMarkReturningPayload, {
    description:
      'The customer refused the parcel, or it could not be delivered: it is coming back.',
  })
  @RequireScopes('write_orders')
  async fulfillmentMarkReturning(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FulfillmentMarkReturningPayload> {
    const result = await this.service.markReturning(tenant, uuidOf('fulfillment', id));
    return payload(FulfillmentMarkReturningPayload, result, tenant);
  }

  @Mutation(() => FulfillmentReceiveReturnPayload, {
    description:
      'Checks a parcel that came back into its location: by its ID, or by the tracking number on ' +
      'its label, as a scanner reads it, spaces and letter case ignored. `restock` says how many ' +
      'of each line go back on the shelf; the rest are written off as damaged. Everything is ' +
      'restocked if left out.',
  })
  @RequireScopes('write_orders')
  async fulfillmentReceiveReturn(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('trackingNumber', {
      type: () => String,
      nullable: true,
      description: 'In place of `id`: one parcel still out must carry it.',
    })
    trackingNumber: string | null,
    @Args('restock', { type: () => [FulfillmentRestockInput], nullable: true })
    restock?: FulfillmentRestockInput[] | null,
  ): Promise<FulfillmentReceiveReturnPayload> {
    if (
      (id === null || id === undefined) ===
      (trackingNumber === null || trackingNumber === undefined)
    ) {
      return Object.assign(new FulfillmentReceiveReturnPayload(), {
        fulfillment: null,
        order: null,
        userErrors: UserError.list([
          {
            field: ['id'],
            code: 'INVALID',
            message: "Give the parcel's ID or its tracking number",
          },
        ]),
      });
    }
    const lines = restock?.map((entry) => ({
      lineItemId: uuidOf('lineItem', entry.lineItemId),
      quantity: entry.quantity,
    }));
    const result = id
      ? await this.service.receiveReturn(tenant, uuidOf('fulfillment', id), lines)
      : await this.service.receiveReturnByTracking(tenant, trackingNumber!, lines);
    return payload(FulfillmentReceiveReturnPayload, result, tenant);
  }

  @Query(() => ReturningParcelConnection, {
    description:
      'Parcels on their way back, refused or undeliverable, the longest on its way first, with ' +
      'how many days each has been: those a courier is slow to bring back, to chase.',
  })
  @RequireScopes('read_orders')
  async returningParcels(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ReturningParcelsArgs,
  ): Promise<ReturningParcelConnection> {
    const { items, hasNextPage } = await this.service.returning(tenant, {
      first: pageSize(args.first),
      after: args.after ? returningCursor(args.after) : null,
      courier: args.courier,
    });
    const edges = items.map((record) =>
      Object.assign(new ReturningParcelEdge(), {
        node: toReturningParcel(record),
        cursor: encodeCursor({ id: record.id, at: record.returningAt.toISOString() }),
      }),
    );
    return Object.assign(new ReturningParcelConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}

/** Where the previous page of parcels coming back ended. */
function returningCursor(after: string): { id: string; returningAt: Date } {
  const { id, at } = decodeCursor(after, ['id', 'at']);
  const returningAt = new Date(at);
  if (!isUuid(id) || Number.isNaN(returningAt.getTime())) {
    throw badUserInput('Invalid cursor');
  }
  return { id, returningAt };
}

function toReturningParcel(record: ReturningParcelRecord): ReturningParcel {
  return Object.assign(new ReturningParcel(), {
    id: toPublicId('fulfillment', record.id),
    orderId: toPublicId('order', record.orderId),
    orderName: orderName(record.orderNumber),
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: record.trackingUrl,
    }),
    shippedAt: record.shippedAt,
    returningAt: record.returningAt,
    days: record.days,
    units: record.units,
  });
}

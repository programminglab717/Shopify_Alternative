import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Location,
  LocationService,
  toLocation,
  type LocationRecord,
} from '@hatti/inventory/public';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { FulfillmentService, type ParcelResult } from '../fulfillment.service.js';
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
      'Checks a parcel that came back into its location. `restock` says how many of each line ' +
      'go back on the shelf; the rest are written off as damaged. Everything is restocked if ' +
      'left out.',
  })
  @RequireScopes('write_orders')
  async fulfillmentReceiveReturn(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('restock', { type: () => [FulfillmentRestockInput], nullable: true })
    restock?: FulfillmentRestockInput[] | null,
  ): Promise<FulfillmentReceiveReturnPayload> {
    const result = await this.service.receiveReturn(
      tenant,
      uuidOf('fulfillment', id),
      restock?.map((entry) => ({
        lineItemId: uuidOf('lineItem', entry.lineItemId),
        quantity: entry.quantity,
      })),
    );
    return payload(FulfillmentReceiveReturnPayload, result, tenant);
  }
}

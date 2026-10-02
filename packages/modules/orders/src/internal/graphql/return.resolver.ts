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
import { ReturnService, type ReturnResult } from '../return.service.js';
import type { ReturnReasonValue } from '../schema.js';
import { toOrder, uuidOf } from './mappers.js';
import {
  Return,
  ReturnCancelPayload,
  ReturnCreateInput,
  ReturnCreatePayload,
  ReturnReceivePayload,
  ReturnRestockInput,
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

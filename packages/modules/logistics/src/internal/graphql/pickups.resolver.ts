import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CourierPickupService, type CourierPickupRecord } from '../pickups.service.js';
import { toBooking, uuidOf } from './couriers.resolver.js';
import {
  CourierBooking,
  CourierPickup,
  CourierPickupInput,
  CourierPickupPayload,
  CourierPickupStatus,
} from './couriers.types.js';

/**
 * Pickups (SHP-02, ADR-253): a courier account's parcels waiting to be picked up, handed to its
 * courier through the courier's API. Orders' work, packers' included, as booking is.
 */
@Resolver(() => CourierPickup)
export class CourierPickupResolver {
  constructor(private readonly pickups: CourierPickupService) {}

  @Mutation(() => CourierPickupPayload, {
    description:
      "Hands a courier account's parcels waiting to be picked up, the default account's unless " +
      "given, to its courier through the courier's API, the longest waiting first, up to 200: " +
      "PostEx's load sheet for the account's pickup address, or Leopards' naming the rider who " +
      'takes them. Parcels in a pickup the courier took go in the next only once they have ' +
      'waited a day since. Refused, with why, for a courier whose API takes no pickups, whose ' +
      'rider is not named, or that refuses them.',
  })
  @RequireScopes('write_orders')
  async courierPickupRequest(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CourierPickupInput,
  ): Promise<CourierPickupPayload> {
    const result = await this.pickups.request(tenant, {
      accountId: input.accountId ? uuidOf('courierAccount', input.accountId) : null,
      riderName: input.riderName,
      riderCode: input.riderCode,
    });
    return Object.assign(new CourierPickupPayload(), {
      courierPickup: result.ok ? this.#toPickup(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [CourierPickup], {
    description: "The shop's pickups, the latest first, of one courier account if given.",
  })
  @RequireScopes('read_orders')
  async courierPickups(
    @CurrentTenant() tenant: TenantContext,
    @Args('accountId', { type: () => ID, nullable: true }) accountId?: string | null,
    @Args('first', { type: () => Int, defaultValue: 20, description: 'Up to 50.' })
    first = 20,
  ): Promise<CourierPickup[]> {
    const records = await this.pickups.list(tenant, {
      accountId: accountId ? uuidOf('courierAccount', accountId) : null,
      first,
    });
    return records.map((record) => this.#toPickup(record));
  }

  @Query(() => CourierPickup, { nullable: true })
  @RequireScopes('read_orders')
  async courierPickup(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CourierPickup | null> {
    const record = await this.pickups.get(tenant, uuidOf('courierPickup', id));
    return record && this.#toPickup(record);
  }

  @ResolveField(() => [CourierBooking], {
    description: 'The bookings of the parcels it handed over, the longest waiting first.',
  })
  async bookings(
    @CurrentTenant() tenant: TenantContext,
    @Parent() pickup: CourierPickup,
  ): Promise<CourierBooking[]> {
    const records = await this.pickups.bookingsOf(tenant, uuidOf('courierPickup', pickup.id));
    return records.map((record) => toBooking(record, tenant.currency));
  }

  #toPickup(record: CourierPickupRecord): CourierPickup {
    return Object.assign(new CourierPickup(), {
      id: toPublicId('courierPickup', record.id),
      accountId: toPublicId('courierAccount', record.accountId),
      courier: record.courier,
      courierName: record.courierName,
      status: record.status.toUpperCase() as CourierPickupStatus,
      parcelCount: record.parcelCount,
      reference: record.reference,
      riderName: record.rider?.name ?? null,
      riderCode: record.rider?.code ?? null,
      loadSheetUrl: this.pickups.documentUrlOf(record),
      error: record.error,
      requestedAt: record.requestedAt,
      createdAt: record.createdAt,
    });
  }
}

import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  CourierPickupService,
  type CourierPickupRecord,
  type PickupParcelRecord,
} from '../pickups.service.js';
import { toBooking, uuidOf } from './couriers.resolver.js';
import {
  CourierBooking,
  CourierPickup,
  CourierPickupInput,
  CourierPickupParcel,
  CourierPickupParcelHandOverPayload,
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

  @Mutation(() => CourierPickupParcelHandOverPayload, {
    description:
      "Checks off the pickup's parcel with this tracking number as the courier's rider takes it, " +
      'scanned from its label (SHP-02, APP-04, ADR-377). A parcel checked off already stays as it ' +
      'was and says so. Refused for a pickup its courier has not taken, and for a tracking number ' +
      'not among its parcels.',
  })
  @RequireScopes('write_orders')
  async courierPickupParcelHandOver(
    @CurrentTenant() tenant: TenantContext,
    @Args('pickupId', { type: () => ID }) pickupId: string,
    @Args('trackingNumber') trackingNumber: string,
  ): Promise<CourierPickupParcelHandOverPayload> {
    const result = await this.pickups.handOver(
      tenant,
      uuidOf('courierPickup', pickupId),
      trackingNumber,
    );
    return Object.assign(new CourierPickupParcelHandOverPayload(), {
      parcel: result.ok ? toParcel(result.value.parcel, tenant.currency) : null,
      alreadyHandedOver: result.ok && result.value.already,
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

  @ResolveField(() => [CourierPickupParcel], {
    description:
      'Its parcels, the longest waiting first, each with whether its rider has taken it (ADR-377).',
  })
  async parcels(
    @CurrentTenant() tenant: TenantContext,
    @Parent() pickup: CourierPickup,
  ): Promise<CourierPickupParcel[]> {
    const records = await this.pickups.parcelsOf(tenant, uuidOf('courierPickup', pickup.id));
    return records.map((record) => toParcel(record, tenant.currency));
  }

  #toPickup(record: CourierPickupRecord): CourierPickup {
    return Object.assign(new CourierPickup(), {
      id: toPublicId('courierPickup', record.id),
      accountId: toPublicId('courierAccount', record.accountId),
      courier: record.courier,
      courierName: record.courierName,
      status: record.status.toUpperCase() as CourierPickupStatus,
      parcelCount: record.parcelCount,
      handedOverCount: record.handedOverCount,
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

function toParcel(record: PickupParcelRecord, currency: CurrencyCode): CourierPickupParcel {
  return Object.assign(new CourierPickupParcel(), {
    booking: toBooking(record.booking, currency),
    handedOverAt: record.handedOverAt,
  });
}

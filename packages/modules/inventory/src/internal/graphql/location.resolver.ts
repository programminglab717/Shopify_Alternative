import {
  CurrentTenant,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { LocationService } from '../location.service.js';
import {
  Location,
  LocationActivatePayload,
  LocationAddInput,
  LocationAddPayload,
  LocationConnection,
  LocationDeactivatePayload,
  LocationDeletePayload,
  LocationEditInput,
  LocationEditPayload,
  LocationsArgs,
} from './location.types.js';
import { toLocation, toLocationConnection, uuidOf } from './mappers.js';

@Resolver(() => Location)
export class LocationResolver {
  constructor(private readonly service: LocationService) {}

  @Query(() => Location, {
    nullable: true,
    description: 'A location by ID, or the primary location when no ID is given.',
  })
  @RequireScopes('read_locations')
  async location(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID, nullable: true }) id?: string | null,
  ): Promise<Location | null> {
    const record = id
      ? await this.service.get(tenant, uuidOf('location', id))
      : await this.service.primary(tenant);
    return record ? toLocation(record) : null;
  }

  @Query(() => LocationConnection, {
    description: 'Locations in the order they were added; the first is primary.',
  })
  @RequireScopes('read_locations')
  async locations(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: LocationsArgs,
  ): Promise<LocationConnection> {
    const after = args.after ? uuidOf('location', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
      includeInactive: args.includeInactive,
    });
    return toLocationConnection(items, hasNextPage);
  }

  @Mutation(() => LocationAddPayload, {
    description: "Adds a location. A shop's first location is its primary one.",
  })
  @RequireScopes('write_locations')
  async locationAdd(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: LocationAddInput,
  ): Promise<LocationAddPayload> {
    const result = await this.service.add(tenant, input);
    return Object.assign(new LocationAddPayload(), {
      location: result.ok ? toLocation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => LocationEditPayload)
  @RequireScopes('write_locations')
  async locationEdit(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: LocationEditInput,
  ): Promise<LocationEditPayload> {
    const result = await this.service.edit(tenant, uuidOf('location', id), input);
    return Object.assign(new LocationEditPayload(), {
      location: result.ok ? toLocation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => LocationDeactivatePayload, {
    description:
      'Takes a location out of use. It must hold no stock and have no orders or checkouts ' +
      'waiting on it, and it cannot be the primary location.',
  })
  @RequireScopes('write_locations')
  async locationDeactivate(
    @CurrentTenant() tenant: TenantContext,
    @Args('locationId', { type: () => ID }) locationId: string,
  ): Promise<LocationDeactivatePayload> {
    const result = await this.service.deactivate(tenant, uuidOf('location', locationId));
    return Object.assign(new LocationDeactivatePayload(), {
      location: result.ok ? toLocation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => LocationActivatePayload)
  @RequireScopes('write_locations')
  async locationActivate(
    @CurrentTenant() tenant: TenantContext,
    @Args('locationId', { type: () => ID }) locationId: string,
  ): Promise<LocationActivatePayload> {
    const result = await this.service.activate(tenant, uuidOf('location', locationId));
    return Object.assign(new LocationActivatePayload(), {
      location: result.ok ? toLocation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => LocationDeletePayload, {
    description: 'Deletes a location that never held stock; deactivate others instead.',
  })
  @RequireScopes('write_locations')
  async locationDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('locationId', { type: () => ID }) locationId: string,
  ): Promise<LocationDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('location', locationId));
    return Object.assign(new LocationDeletePayload(), {
      deletedLocationId: result.ok ? toPublicId('location', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

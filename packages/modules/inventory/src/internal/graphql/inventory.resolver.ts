import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import { untrackedItem } from '../item-store.js';
import type { InventoryItemRecord } from '../records.js';
import {
  InventoryAdjustQuantitiesInput,
  InventoryAdjustQuantitiesPayload,
  InventoryChange,
  InventoryChangeConnection,
  InventoryChangesArgs,
  InventoryItem,
  InventoryItemInput,
  InventoryItemUpdatePayload,
  InventoryLevel,
  InventorySetQuantitiesInput,
  InventorySetQuantitiesPayload,
} from './inventory.types.js';
import {
  changeCursorAfter,
  toAdjustmentGroup,
  toChangeConnection,
  toInventoryItem,
  toPolicyValue,
  uuidOf,
} from './mappers.js';

/**
 * Items of variants by variant ID, loaded together for a whole request: a page of products and
 * their variants costs one query.
 */
export async function loadItem(
  loaders: RequestLoaders,
  service: InventoryService,
  tenant: TenantContext,
  variantId: string,
): Promise<InventoryItemRecord> {
  const loader = loaders.get<string, InventoryItemRecord>('inventory.items', (variantIds) =>
    service.itemsOf(tenant, variantIds),
  );
  return (await loader.load(variantId)) ?? untrackedItem(variantId);
}

@Resolver(() => InventoryItem)
export class InventoryItemResolver {
  constructor(private readonly service: InventoryService) {}

  @Query(() => InventoryItem, { nullable: true, description: 'An inventory item by ID.' })
  @RequireScopes('read_inventory')
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<InventoryItem | null> {
    const record = await this.service.item(tenant, uuidOf('inventoryItem', id));
    return record ? toInventoryItem(record) : null;
  }

  @ResolveField(() => InventoryLevel, {
    nullable: true,
    description: 'Its level at an active location, or null if it was never stocked there.',
  })
  inventoryLevel(
    @Parent() item: InventoryItem,
    @Args('locationId', { type: () => ID }) locationId: string,
  ): InventoryLevel | null {
    const id = toPublicId('location', uuidOf('location', locationId));
    return item.inventoryLevels.find((level) => level.location.id === id) ?? null;
  }

  @ResolveField(() => InventoryChangeConnection, {
    description: 'Changes to its quantities, newest first.',
  })
  async changes(
    @CurrentTenant() tenant: TenantContext,
    @Parent() item: InventoryItem,
    @Args() args: InventoryChangesArgs,
  ): Promise<InventoryChangeConnection> {
    const { items, hasNextPage } = await this.service.history(tenant, item.variantId, {
      first: pageSize(args.first),
      after: changeCursorAfter(args.after),
      locationId: args.locationId ? uuidOf('location', args.locationId) : null,
    });
    return toChangeConnection(items, hasNextPage);
  }

  @Mutation(() => InventoryItemUpdatePayload, {
    description: 'Turns tracking on or off, or changes what happens at zero available.',
  })
  @RequireScopes('write_inventory')
  async inventoryItemUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: InventoryItemInput,
  ): Promise<InventoryItemUpdatePayload> {
    const result = await this.service.updateItem(tenant, uuidOf('inventoryItem', id), {
      tracked: input.tracked,
      inventoryPolicy: input.inventoryPolicy ? toPolicyValue(input.inventoryPolicy) : null,
    });
    return Object.assign(new InventoryItemUpdatePayload(), {
      inventoryItem: result.ok ? toInventoryItem(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => InventoryAdjustQuantitiesPayload, {
    description:
      'Adds to or takes from quantities: a delivery received, damaged goods written off. ' +
      'Stock recorded for an untracked item starts tracking it. All changes apply, or none.',
  })
  @RequireScopes('write_inventory')
  async inventoryAdjustQuantities(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: InventoryAdjustQuantitiesInput,
  ): Promise<InventoryAdjustQuantitiesPayload> {
    const result = await this.service.adjustQuantities(tenant, {
      ...input,
      changes: input.changes.map((change) => ({
        inventoryItemId: uuidOf('inventoryItem', change.inventoryItemId),
        locationId: uuidOf('location', change.locationId),
        delta: change.delta,
      })),
    });
    return Object.assign(new InventoryAdjustQuantitiesPayload(), {
      inventoryAdjustmentGroup: result.ok && result.value ? toAdjustmentGroup(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => InventorySetQuantitiesPayload, {
    description:
      'Sets quantities, as after a stock count. Stock recorded for an untracked item starts ' +
      'tracking it. All quantities are set, or none.',
  })
  @RequireScopes('write_inventory')
  async inventorySetQuantities(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: InventorySetQuantitiesInput,
  ): Promise<InventorySetQuantitiesPayload> {
    const result = await this.service.setQuantities(tenant, {
      ...input,
      quantities: input.quantities.map((entry) => ({
        inventoryItemId: uuidOf('inventoryItem', entry.inventoryItemId),
        locationId: uuidOf('location', entry.locationId),
        quantity: entry.quantity,
        compareQuantity: entry.compareQuantity,
      })),
    });
    return Object.assign(new InventorySetQuantitiesPayload(), {
      inventoryAdjustmentGroup: result.ok && result.value ? toAdjustmentGroup(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

@Resolver(() => InventoryChange)
export class InventoryChangeResolver {
  constructor(private readonly service: InventoryService) {}

  @ResolveField(() => InventoryItem, { description: 'The item, as it is now.' })
  async item(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() change: InventoryChange,
  ): Promise<InventoryItem> {
    return toInventoryItem(await loadItem(loaders, this.service, tenant, change.variantId));
  }
}

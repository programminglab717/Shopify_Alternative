import {
  CurrentTenant,
  Loaders,
  PageInfo,
  RequestLoaders,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId } from '@hatti/ids';
import { Args, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import {
  LowStockService,
  type InventorySettingsRecord,
  type LowStockCursor,
  type LowStockRecord,
} from '../low-stock.service.js';
import { loadItem } from './inventory.resolver.js';
import { InventoryItem } from './inventory.types.js';
import {
  InventorySettings,
  InventorySettingsInput,
  InventorySettingsUpdatePayload,
  LowStockItem,
  LowStockItemConnection,
  LowStockItemEdge,
} from './low-stock.types.js';
import { toInventoryItem } from './mappers.js';

/** Low stock (INV-01, ADR-125): what the shop calls low, and the variants running low or out. */
@Resolver()
export class LowStockResolver {
  constructor(private readonly lowStock: LowStockService) {}

  @Query(() => InventorySettings, { description: "The shop's inventory settings." })
  @RequireScopes('read_inventory')
  async inventorySettings(@CurrentTenant() tenant: TenantContext): Promise<InventorySettings> {
    return toSettings(await this.lowStock.settings(tenant));
  }

  @Mutation(() => InventorySettingsUpdatePayload, {
    description: 'Changes what the shop calls low stock.',
  })
  @RequireScopes('write_inventory')
  async inventorySettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: InventorySettingsInput,
  ): Promise<InventorySettingsUpdatePayload> {
    const result = await this.lowStock.updateSettings(tenant, {
      ...(input.lowStockThreshold !== undefined && { lowStockThreshold: input.lowStockThreshold }),
    });
    return Object.assign(new InventorySettingsUpdatePayload(), {
      inventorySettings: result.ok ? toSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => LowStockItemConnection, {
    description:
      "The shop's variants of active products running low or out of stock, at its threshold: " +
      'the fewest for sale first, to reorder.',
  })
  @RequireScopes('read_inventory')
  async inventoryLowStock(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true, description: '1 to 250; default 50.' })
    first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): Promise<LowStockItemConnection> {
    const { items, hasNextPage } = await this.lowStock.list(tenant, {
      first: pageSize(first),
      after: lowStockCursorAfter(after),
    });
    const edges = items.map((record) =>
      Object.assign(new LowStockItemEdge(), {
        node: toLowStockItem(record),
        cursor: encodeCursor({ available: String(record.available), id: record.variantId }),
      }),
    );
    return Object.assign(new LowStockItemConnection(), {
      edges,
      nodes: edges.map((edge) => edge.node),
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }
}

@Resolver(() => LowStockItem)
export class LowStockItemResolver {
  constructor(private readonly service: InventoryService) {}

  @ResolveField(() => InventoryItem, { description: 'How its stock is counted, and where it is.' })
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() item: LowStockItem,
  ): Promise<InventoryItem> {
    return toInventoryItem(await loadItem(loaders, this.service, tenant, item.record.variantId));
  }
}

function toSettings(record: InventorySettingsRecord): InventorySettings {
  return Object.assign(new InventorySettings(), { lowStockThreshold: record.lowStockThreshold });
}

function toLowStockItem(record: LowStockRecord): LowStockItem {
  return Object.assign(new LowStockItem(), {
    variantId: toPublicId('variant', record.variantId),
    productId: toPublicId('product', record.productId),
    productTitle: record.productTitle,
    variantTitle: record.variantTitle,
    sku: record.sku,
    available: record.available,
    record,
  });
}

/** Where a page of the low-stock list ended, or a BAD_USER_INPUT error. */
function lowStockCursorAfter(after: string | null): LowStockCursor | null {
  if (!after) return null;
  const { available, id } = decodeCursor(after, ['available', 'id']);
  if (!/^-?\d{1,9}$/.test(available) || !isUuid(id)) throw badUserInput('Invalid cursor');
  return { available: Number(available), variantId: id };
}

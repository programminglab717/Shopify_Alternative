import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  type TenantContext,
} from '@hatti/api';
import { Product, ProductVariant } from '@hatti/catalog/public';
import { Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { InventoryService } from '../inventory.service.js';
import { availableForSale, sellableQuantity } from '../item-store.js';
import type { InventoryItemRecord } from '../records.js';
import { loadItem } from './inventory.resolver.js';
import { InventoryItem } from './inventory.types.js';
import { toInventoryItem, uuidOf } from './mappers.js';

// Stock fields on the catalog's types. Each loads through the request's batch loader, so a page
// of 50 products with their variants reads stock with one query.

@Resolver(() => ProductVariant)
export class VariantInventoryResolver {
  constructor(private readonly service: InventoryService) {}

  #item(
    tenant: TenantContext,
    loaders: RequestLoaders,
    variant: ProductVariant,
  ): Promise<InventoryItemRecord> {
    return loadItem(loaders, this.service, tenant, uuidOf('variant', variant.id));
  }

  @ResolveField(() => InventoryItem, {
    description: "How the variant's stock is counted, and where it is.",
  })
  @RequireScopes('read_inventory')
  async inventoryItem(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() variant: ProductVariant,
  ): Promise<InventoryItem> {
    return toInventoryItem(await this.#item(tenant, loaders, variant));
  }

  @ResolveField(() => Int, {
    description:
      'Units that can be sold online: available at active locations that fulfil online orders.',
  })
  @RequireScopes('read_inventory')
  async inventoryQuantity(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() variant: ProductVariant,
  ): Promise<number> {
    return sellableQuantity(await this.#item(tenant, loaders, variant));
  }

  @ResolveField(() => Boolean, {
    description:
      'Whether stock allows selling it online: it is not tracked, it sells on at zero, or some ' +
      'can be sold.',
  })
  @RequireScopes('read_inventory')
  async availableForSale(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() variant: ProductVariant,
  ): Promise<boolean> {
    return availableForSale(await this.#item(tenant, loaders, variant));
  }
}

@Resolver(() => Product)
export class ProductInventoryResolver {
  constructor(private readonly service: InventoryService) {}

  #items(
    tenant: TenantContext,
    loaders: RequestLoaders,
    product: Product,
  ): Promise<InventoryItemRecord[]> {
    return Promise.all(
      product.variants.map((variant) =>
        loadItem(loaders, this.service, tenant, uuidOf('variant', variant.id)),
      ),
    );
  }

  @ResolveField(() => Int, {
    description: 'Units that can be sold online, across its tracked variants.',
  })
  @RequireScopes('read_inventory')
  async totalInventory(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<number> {
    const items = await this.#items(tenant, loaders, product);
    return items
      .filter((item) => item.tracked)
      .reduce((sum, item) => sum + sellableQuantity(item), 0);
  }

  @ResolveField(() => Boolean, { description: 'Whether stock is tracked for any of its variants.' })
  @RequireScopes('read_inventory')
  async tracksInventory(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<boolean> {
    const items = await this.#items(tenant, loaders, product);
    return items.some((item) => item.tracked);
  }
}

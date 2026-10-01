import { CatalogModule } from '@hatti/catalog/public';
import { Module } from '@nestjs/common';
import { InventoryChangeResolver, InventoryItemResolver } from './graphql/inventory.resolver.js';
import { LocationResolver } from './graphql/location.resolver.js';
import { LowStockItemResolver, LowStockResolver } from './graphql/low-stock.resolver.js';
import {
  ProductInventoryResolver,
  VariantInventoryResolver,
} from './graphql/variant-inventory.resolver.js';
import { InventoryService } from './inventory.service.js';
import { LocationService } from './location.service.js';
import { LowStockService } from './low-stock.service.js';
import { StockService } from './stock.service.js';

/**
 * Needs a {@link Database} provider from the host application. Adds stock fields to the
 * catalog's Product and ProductVariant types.
 */
@Module({
  imports: [CatalogModule],
  providers: [
    LocationService,
    InventoryService,
    StockService,
    LowStockService,
    LocationResolver,
    LowStockResolver,
    LowStockItemResolver,
    InventoryItemResolver,
    InventoryChangeResolver,
    VariantInventoryResolver,
    ProductInventoryResolver,
  ],
  exports: [LocationService, InventoryService, StockService, LowStockService],
})
export class InventoryModule {}

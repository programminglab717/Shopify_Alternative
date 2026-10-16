import { CatalogModule } from '@hatti/catalog/public';
import { Module } from '@nestjs/common';
import { InventoryChangeResolver, InventoryItemResolver } from './graphql/inventory.resolver.js';
import { ProductPreorderResolver } from './graphql/preorder.resolver.js';
import { LocationResolver } from './graphql/location.resolver.js';
import { LowStockItemResolver, LowStockResolver } from './graphql/low-stock.resolver.js';
import { StockValueResolver } from './graphql/stock-value.resolver.js';
import { InventoryReportResolver } from './graphql/inventory-report.resolver.js';
import { InventoryReportService } from './inventory-report.service.js';
import {
  LowStockReorderResolver,
  PurchaseOrderLineResolver,
  PurchaseOrderResolver,
  SupplierResolver,
} from './graphql/purchase-order.resolver.js';
import { TransferLineResolver, TransferResolver } from './graphql/transfer.resolver.js';
import {
  ProductInventoryResolver,
  VariantInventoryResolver,
} from './graphql/variant-inventory.resolver.js';
import { InventoryService } from './inventory.service.js';
import { LocationService } from './location.service.js';
import { LowStockService } from './low-stock.service.js';
import { PreorderService } from './preorders.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { StockValueService } from './stock-value.service.js';
import { StockService } from './stock.service.js';
import { TransferService } from './transfer.service.js';

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
    PurchaseOrderService,
    TransferService,
    StockValueService,
    InventoryReportService,
    PreorderService,
    ProductPreorderResolver,
    LocationResolver,
    PurchaseOrderResolver,
    PurchaseOrderLineResolver,
    SupplierResolver,
    TransferResolver,
    TransferLineResolver,
    LowStockResolver,
    LowStockItemResolver,
    LowStockReorderResolver,
    StockValueResolver,
    InventoryReportResolver,
    InventoryItemResolver,
    InventoryChangeResolver,
    VariantInventoryResolver,
    ProductInventoryResolver,
  ],
  exports: [
    LocationService,
    InventoryService,
    StockService,
    LowStockService,
    PurchaseOrderService,
    TransferService,
    PreorderService,
  ],
})
export class InventoryModule {}

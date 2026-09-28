import { CatalogModule } from '@hatti/catalog/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { OrderResolver } from './graphql/order.resolver.js';
import { OrderService } from './order.service.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  imports: [CatalogModule, InventoryModule],
  providers: [OrderService, OrderResolver],
  exports: [OrderService],
})
export class OrdersModule {}

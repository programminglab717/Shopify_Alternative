import { CatalogModule } from '@hatti/catalog/public';
import { CustomersModule } from '@hatti/customers/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { OrderSegmentFacts } from './customer-facts.js';
import { FulfillmentService } from './fulfillment.service.js';
import { CustomerOrdersResolver } from './graphql/customer-orders.resolver.js';
import { FulfillmentResolver } from './graphql/fulfillment.resolver.js';
import { OrderResolver } from './graphql/order.resolver.js';
import { OrderService } from './order.service.js';

/**
 * Needs a {@link Database} provider from the host application. Adds a customer's orders and what
 * they add up to to the customers module's Customer type, and order fields to segments.
 */
@Module({
  imports: [CatalogModule, InventoryModule, CustomersModule],
  providers: [
    OrderService,
    FulfillmentService,
    OrderResolver,
    FulfillmentResolver,
    CustomerOrdersResolver,
    OrderSegmentFacts,
  ],
  exports: [OrderService, FulfillmentService],
})
export class OrdersModule {}

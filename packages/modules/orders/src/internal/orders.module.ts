import { CatalogModule } from '@hatti/catalog/public';
import { CustomersModule } from '@hatti/customers/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { OrderSegmentFacts } from './customer-facts.js';
import { OrderDocumentService } from './document.service.js';
import { OrderCustomerData } from './order-customer-data.js';
import { FulfillmentService } from './fulfillment.service.js';
import { CustomerOrdersResolver } from './graphql/customer-orders.resolver.js';
import { OrderDocumentResolver } from './graphql/document.resolver.js';
import { FulfillmentResolver } from './graphql/fulfillment.resolver.js';
import { OrderResolver } from './graphql/order.resolver.js';
import { RefundResolver } from './graphql/refund.resolver.js';
import { RiskResolver } from './graphql/risk.resolver.js';
import { OrderService } from './order.service.js';
import { RefundService } from './refund.service.js';
import { RiskSettingsService } from './risk-settings.service.js';

/**
 * Needs a {@link Database} provider from the host application. Adds a customer's orders and what
 * they add up to to the customers module's Customer type, order fields to segments, and orders to
 * merging and erasing customers.
 */
@Module({
  imports: [CatalogModule, InventoryModule, CustomersModule],
  providers: [
    OrderService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    RefundService,
    OrderResolver,
    FulfillmentResolver,
    CustomerOrdersResolver,
    RiskResolver,
    OrderDocumentResolver,
    RefundResolver,
    OrderSegmentFacts,
    OrderCustomerData,
  ],
  exports: [
    OrderService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    RefundService,
  ],
})
export class OrdersModule {}

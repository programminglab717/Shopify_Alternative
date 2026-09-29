import { CatalogModule } from '@hatti/catalog/public';
import { CustomersModule } from '@hatti/customers/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { OrderSegmentFacts } from './customer-facts.js';
import { OrderDocumentService } from './document.service.js';
import { DraftLinkController } from './draft-link.controller.js';
import { DraftOrderService } from './draft-order.service.js';
import { OrderCustomerData } from './order-customer-data.js';
import { FulfillmentService } from './fulfillment.service.js';
import { CustomerOrdersResolver } from './graphql/customer-orders.resolver.js';
import { OrderDocumentResolver } from './graphql/document.resolver.js';
import { DraftOrderResolver } from './graphql/draft-order.resolver.js';
import { OrderExportResolver } from './graphql/export.resolver.js';
import { FulfillmentResolver } from './graphql/fulfillment.resolver.js';
import { OrderResolver } from './graphql/order.resolver.js';
import { RefundResolver } from './graphql/refund.resolver.js';
import { RiskResolver } from './graphql/risk.resolver.js';
import { OrderExportService } from './order-export.service.js';
import { OrderService } from './order.service.js';
import { RefundService } from './refund.service.js';
import { RiskSettingsService } from './risk-settings.service.js';

/**
 * Needs {@link Database} and PublicSite providers from the host application. Adds a customer's
 * orders and what they add up to to the customers module's Customer type, order fields to
 * segments, and orders to merging and erasing customers. Serves draft orders' links at /d/.
 */
@Module({
  imports: [CatalogModule, InventoryModule, CustomersModule],
  controllers: [DraftLinkController],
  providers: [
    OrderService,
    DraftOrderService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    OrderExportService,
    RefundService,
    OrderResolver,
    FulfillmentResolver,
    CustomerOrdersResolver,
    RiskResolver,
    OrderDocumentResolver,
    OrderExportResolver,
    RefundResolver,
    DraftOrderResolver,
    OrderSegmentFacts,
    OrderCustomerData,
  ],
  exports: [
    OrderService,
    DraftOrderService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    OrderExportService,
    RefundService,
  ],
})
export class OrdersModule {}

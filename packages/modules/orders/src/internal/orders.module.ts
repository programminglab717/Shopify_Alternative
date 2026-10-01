import { CatalogModule } from '@hatti/catalog/public';
import { CustomersModule } from '@hatti/customers/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { CodHealthService } from './cod-health.service.js';
import { CodReceivablesService } from './cod-receivables.service.js';
import { ConfirmationDeskService } from './confirmation-desk.service.js';
import { OrderSettingsService } from './order-settings.service.js';
import { OrderSegmentFacts } from './customer-facts.js';
import { OrderDocumentService } from './document.service.js';
import { DraftOrderService } from './draft-order.service.js';
import { OrderCustomerData } from './order-customer-data.js';
import { FulfillmentService } from './fulfillment.service.js';
import { CodHealthResolver } from './graphql/cod-health.resolver.js';
import { CodReceivablesResolver } from './graphql/cod-receivables.resolver.js';
import { ConfirmationDeskResolver } from './graphql/confirmation-desk.resolver.js';
import { OrderSettingsResolver } from './graphql/order-settings.resolver.js';
import { CustomerOrdersResolver } from './graphql/customer-orders.resolver.js';
import { OrderDocumentResolver } from './graphql/document.resolver.js';
import { OrderLinkResolver } from './graphql/order-link.resolver.js';
import { DraftOrderResolver } from './graphql/draft-order.resolver.js';
import { OrderExportResolver } from './graphql/export.resolver.js';
import { FulfillmentResolver } from './graphql/fulfillment.resolver.js';
import { OrderResolver } from './graphql/order.resolver.js';
import { RefundResolver } from './graphql/refund.resolver.js';
import { RiskResolver } from './graphql/risk.resolver.js';
import { SalesReportResolver } from './graphql/sales-report.resolver.js';
import { DraftLinkController, OrderLinkController } from './links.controller.js';
import { OrderExportService } from './order-export.service.js';
import { OrderLinkService } from './order-link.service.js';
import { OrderService } from './order.service.js';
import { RefundService } from './refund.service.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { SalesReportService } from './sales-report.service.js';

/**
 * Needs {@link Database} and PublicSite providers from the host application. Adds a customer's
 * orders and what they add up to to the customers module's Customer type, order fields to
 * segments, and orders to merging and erasing customers. Serves draft orders' links at /d/ and
 * orders' at /o/.
 */
@Module({
  imports: [CatalogModule, InventoryModule, CustomersModule],
  controllers: [DraftLinkController, OrderLinkController],
  providers: [
    OrderService,
    DraftOrderService,
    OrderLinkService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    OrderExportService,
    RefundService,
    CodHealthService,
    CodReceivablesService,
    ConfirmationDeskService,
    OrderSettingsService,
    SalesReportService,
    OrderResolver,
    FulfillmentResolver,
    CustomerOrdersResolver,
    RiskResolver,
    OrderDocumentResolver,
    OrderExportResolver,
    RefundResolver,
    DraftOrderResolver,
    OrderLinkResolver,
    CodHealthResolver,
    CodReceivablesResolver,
    ConfirmationDeskResolver,
    OrderSettingsResolver,
    SalesReportResolver,
    OrderSegmentFacts,
    OrderCustomerData,
  ],
  exports: [
    OrderService,
    DraftOrderService,
    OrderLinkService,
    FulfillmentService,
    RiskSettingsService,
    OrderDocumentService,
    OrderExportService,
    RefundService,
    CodHealthService,
    CodReceivablesService,
    ConfirmationDeskService,
    OrderSettingsService,
    SalesReportService,
  ],
})
export class OrdersModule {}

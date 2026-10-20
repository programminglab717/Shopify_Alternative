import { CatalogModule } from '@hatti/catalog/public';
import { CustomersModule } from '@hatti/customers/public';
import { InventoryModule } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { OrdersModule } from '@hatti/orders/public';
import { Module } from '@nestjs/common';
import { AbandonedCheckoutService } from './abandoned.service.js';
import { StorefrontAccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import {
  CheckoutController,
  ReminderLinkController,
  StorefrontCheckoutController,
  StorefrontPaymentLinkController,
} from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { CodRulesService } from './cod-rules.service.js';
import { CheckoutCustomerData } from './customer-data.js';
import { DeliveryService } from './delivery.service.js';
import { AbandonedCheckoutResolver } from './graphql/abandoned.resolver.js';
import { CodRulesResolver } from './graphql/cod-rules.resolver.js';
import { CustomerAddressesResolver } from './graphql/customer-addresses.resolver.js';
import { DeliveryResolver } from './graphql/delivery.resolver.js';
import { GiftOptionsResolver } from './graphql/gift-options.resolver.js';
import { CheckoutMarketingResolver } from './graphql/marketing.resolver.js';
import { PaymentLinkResolver } from './graphql/payment-link.resolver.js';
import { TrustBadgeResolver } from './graphql/trust-badge.resolver.js';
import { GiftOptionsService } from './gift-options.service.js';
import { CheckoutMarketingService } from './marketing.service.js';
import { PaymentLinkService } from './payment-link.service.js';
import { TrustBadgeService } from './trust-badge.service.js';

/**
 * Needs {@link Database}, {@link PublicSite}, {@link StorefrontSite} and ObjectStorage providers
 * from the host application, which also checks the storefront key on the routes under
 * /storefront/.
 */
@Module({
  imports: [CatalogModule, CustomersModule, InventoryModule, OrdersModule],
  providers: [
    CartService,
    DeliveryService,
    DeliveryResolver,
    CodRulesService,
    CodRulesResolver,
    TrustBadgeService,
    TrustBadgeResolver,
    CheckoutMarketingService,
    CheckoutMarketingResolver,
    // Gift wrap and gift messages (CHK-16, ADR-413).
    GiftOptionsService,
    GiftOptionsResolver,
    CheckoutService,
    // Links many customers open, each to a checkout of their own (ADR-248).
    PaymentLinkService,
    PaymentLinkResolver,
    // Checkouts shoppers left, and their reminders (ADR-393).
    AbandonedCheckoutService,
    AbandonedCheckoutResolver,
    // Shoppers' accounts on the storefront, signed in to by a code (CUS-02, ADR-570).
    AccountService,
    // The address books they keep, on the Admin API's customers (ADR-588).
    CustomerAddressesResolver,
    // Sends the codes that prove shoppers' numbers (CHK-09) and sign them in.
    MessagesService,
    // Browsers' proofs of numbers in customers' erasure and exports (ADR-199).
    CheckoutCustomerData,
  ],
  controllers: [
    CartController,
    StorefrontCheckoutController,
    StorefrontPaymentLinkController,
    CheckoutController,
    ReminderLinkController,
    StorefrontAccountController,
  ],
  exports: [
    CartService,
    DeliveryService,
    CodRulesService,
    TrustBadgeService,
    CheckoutMarketingService,
    GiftOptionsService,
    CheckoutService,
    PaymentLinkService,
    AbandonedCheckoutService,
    AccountService,
  ],
})
export class CheckoutModule {}

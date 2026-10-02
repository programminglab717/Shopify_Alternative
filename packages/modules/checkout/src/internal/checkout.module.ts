import { CatalogModule } from '@hatti/catalog/public';
import { InventoryModule } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { OrdersModule } from '@hatti/orders/public';
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { CheckoutController, StorefrontCheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { CodRulesService } from './cod-rules.service.js';
import { DeliveryService } from './delivery.service.js';
import { CodRulesResolver } from './graphql/cod-rules.resolver.js';
import { DeliveryResolver } from './graphql/delivery.resolver.js';
import { TrustBadgeResolver } from './graphql/trust-badge.resolver.js';
import { TrustBadgeService } from './trust-badge.service.js';

/**
 * Needs {@link Database}, {@link PublicSite}, {@link StorefrontSite} and ObjectStorage providers
 * from the host application, which also checks the storefront key on the routes under
 * /storefront/.
 */
@Module({
  imports: [CatalogModule, InventoryModule, OrdersModule],
  providers: [
    CartService,
    DeliveryService,
    DeliveryResolver,
    CodRulesService,
    CodRulesResolver,
    TrustBadgeService,
    TrustBadgeResolver,
    CheckoutService,
    // Sends the codes that prove shoppers' numbers (CHK-09).
    MessagesService,
  ],
  controllers: [CartController, StorefrontCheckoutController, CheckoutController],
  exports: [CartService, DeliveryService, CodRulesService, TrustBadgeService, CheckoutService],
})
export class CheckoutModule {}

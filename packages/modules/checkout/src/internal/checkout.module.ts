import { CatalogModule } from '@hatti/catalog/public';
import { InventoryModule } from '@hatti/inventory/public';
import { OrdersModule } from '@hatti/orders/public';
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { CheckoutController, StorefrontCheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryResolver } from './graphql/delivery.resolver.js';

/**
 * Needs {@link Database}, {@link PublicSite} and {@link StorefrontSite} providers from the host
 * application, which also checks the storefront key on the routes under /storefront/.
 */
@Module({
  imports: [CatalogModule, InventoryModule, OrdersModule],
  providers: [CartService, DeliveryService, DeliveryResolver, CheckoutService],
  controllers: [CartController, StorefrontCheckoutController, CheckoutController],
  exports: [CartService, DeliveryService, CheckoutService],
})
export class CheckoutModule {}

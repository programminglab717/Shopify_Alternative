import { CatalogModule } from '@hatti/catalog/public';
import { InventoryModule } from '@hatti/inventory/public';
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

/**
 * Needs a {@link Database} provider from the host application, which also checks the storefront
 * key on the routes under /storefront/.
 */
@Module({
  imports: [CatalogModule, InventoryModule],
  providers: [CartService],
  controllers: [CartController],
  exports: [CartService],
})
export class CheckoutModule {}

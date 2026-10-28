import { CustomersModule } from '@hatti/customers/public';
import { Module } from '@nestjs/common';
import { AutomaticDiscountService } from './automatic-discount.service.js';
import { DiscountCustomerData } from './customer-data.js';
import { DiscountCodeService } from './discount-code.service.js';
import { AutomaticDiscountResolver } from './graphql/automatic-discount.resolver.js';
import { DiscountCodeResolver } from './graphql/discount-code.resolver.js';
import { PriceListResolver } from './graphql/price-list.resolver.js';
import { PriceListService } from './price-lists.js';
import { SpinWheelController, SpinWheelService } from './spin-wheel.js';
import { SpinWheelResolver } from './graphql/spin-wheel.resolver.js';

/**
 * Needs a {@link Database} provider from the host application. Adds codes' uses to merging and
 * erasing customers.
 */
@Module({
  imports: [CustomersModule],
  providers: [
    DiscountCodeService,
    DiscountCodeResolver,
    AutomaticDiscountService,
    AutomaticDiscountResolver,
    DiscountCustomerData,
    PriceListService,
    PriceListResolver,
    SpinWheelService,
    SpinWheelResolver,
  ],
  // Spins of the shop's wheel, under /storefront/, which the host application checks the
  // storefront key of (ADR-900).
  controllers: [SpinWheelController],
  exports: [DiscountCodeService, AutomaticDiscountService, PriceListService],
})
export class PricingModule {}

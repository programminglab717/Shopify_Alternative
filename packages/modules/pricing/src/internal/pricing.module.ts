import { CustomersModule } from '@hatti/customers/public';
import { Module } from '@nestjs/common';
import { DiscountCustomerData } from './customer-data.js';
import { DiscountCodeService } from './discount-code.service.js';
import { DiscountCodeResolver } from './graphql/discount-code.resolver.js';

/**
 * Needs a {@link Database} provider from the host application. Adds codes' uses to merging and
 * erasing customers.
 */
@Module({
  imports: [CustomersModule],
  providers: [DiscountCodeService, DiscountCodeResolver, DiscountCustomerData],
  exports: [DiscountCodeService],
})
export class PricingModule {}

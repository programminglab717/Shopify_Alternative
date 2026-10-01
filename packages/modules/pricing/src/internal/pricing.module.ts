import { Module } from '@nestjs/common';
import { DiscountCodeService } from './discount-code.service.js';
import { DiscountCodeResolver } from './graphql/discount-code.resolver.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [DiscountCodeService, DiscountCodeResolver],
  exports: [DiscountCodeService],
})
export class PricingModule {}

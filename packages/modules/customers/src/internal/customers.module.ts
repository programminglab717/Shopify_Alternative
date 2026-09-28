import { Module } from '@nestjs/common';
import { BlocklistService } from './blocklist.service.js';
import { CustomerService } from './customer.service.js';
import { BlocklistResolver } from './graphql/blocklist.resolver.js';
import { CustomerResolver } from './graphql/customer.resolver.js';

/** Needs a {@link Database} provider from the host application. */
@Module({
  providers: [CustomerService, BlocklistService, CustomerResolver, BlocklistResolver],
  exports: [CustomerService, BlocklistService],
})
export class CustomersModule {}

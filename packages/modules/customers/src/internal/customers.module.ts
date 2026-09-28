import { Module } from '@nestjs/common';
import { BlocklistService } from './blocklist.service.js';
import { CustomerTransferService } from './customer-transfer.service.js';
import { CustomerService } from './customer.service.js';
import { BlocklistResolver } from './graphql/blocklist.resolver.js';
import { CustomerTransferResolver } from './graphql/customer-transfer.resolver.js';
import { CustomerResolver } from './graphql/customer.resolver.js';
import { SegmentResolver } from './graphql/segment.resolver.js';
import { SegmentFieldRegistry } from './segment-fields.js';
import { SegmentService } from './segment.service.js';

/**
 * Needs a {@link Database} provider from the host application. Other modules add segment fields
 * through {@link SegmentFieldRegistry} when they start.
 */
@Module({
  providers: [
    CustomerService,
    BlocklistService,
    SegmentFieldRegistry,
    SegmentService,
    CustomerTransferService,
    CustomerResolver,
    BlocklistResolver,
    SegmentResolver,
    CustomerTransferResolver,
  ],
  exports: [CustomerService, BlocklistService, SegmentFieldRegistry, SegmentService],
})
export class CustomersModule {}

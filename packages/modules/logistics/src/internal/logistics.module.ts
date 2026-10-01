import { Module } from '@nestjs/common';
import { CodRemittanceResolver } from './graphql/remittance.resolver.js';
import { CodRemittanceService } from './remittance.service.js';

/**
 * Fulfillment and logistics: couriers' remittance statements, their cash received on orders
 * through the orders module's functions. Needs the {@link Database} provider from the host
 * application.
 */
@Module({
  providers: [CodRemittanceService, CodRemittanceResolver],
  exports: [CodRemittanceService],
})
export class LogisticsModule {}

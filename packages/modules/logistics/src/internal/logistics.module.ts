import { InventoryModule } from '@hatti/inventory/public';
import { type DynamicModule, Module } from '@nestjs/common';
import { CourierBookingService } from './bookings.service.js';
import { COURIERS, CourierAccountService } from './courier-accounts.service.js';
import { CourierDocumentService } from './courier-documents.service.js';
import { Couriers, PostExCourier } from './couriers.js';
import { CourierResolver } from './graphql/couriers.resolver.js';
import { CodRemittanceResolver } from './graphql/remittance.resolver.js';
import { CodRemittanceService } from './remittance.service.js';

/**
 * Fulfillment and logistics: couriers' remittance statements, their cash received on orders
 * through the orders module's functions; the shop's courier accounts and its orders' bookings
 * with them. Needs the {@link Database} and {@link SecretBox} providers from the host
 * application, and the couriers shops can book with: PostEx unless given.
 */
@Module({})
export class LogisticsModule {
  static forRoot(options: { couriers?: Couriers } = {}): DynamicModule {
    return {
      module: LogisticsModule,
      // Labels say where parcels come from: the inventory module's locations.
      imports: [InventoryModule],
      providers: [
        { provide: COURIERS, useValue: options.couriers ?? new Couriers([new PostExCourier()]) },
        CodRemittanceService,
        CodRemittanceResolver,
        CourierAccountService,
        CourierBookingService,
        CourierDocumentService,
        CourierResolver,
      ],
      exports: [
        CodRemittanceService,
        CourierAccountService,
        CourierBookingService,
        CourierDocumentService,
      ],
    };
  }
}

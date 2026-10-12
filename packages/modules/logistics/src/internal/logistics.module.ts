import { InventoryModule } from '@hatti/inventory/public';
import { type DynamicModule, Module } from '@nestjs/common';
import { CourierBookingService } from './bookings.service.js';
import { COURIERS, CourierAccountService } from './courier-accounts.service.js';
import { CourierCityService } from './courier-cities.service.js';
import { CourierDocumentService } from './courier-documents.service.js';
import { CourierRuleService } from './courier-rules.service.js';
import { Couriers, LeopardsCourier, PostExCourier } from './couriers.js';
import { CourierRuleResolver } from './graphql/courier-rules.resolver.js';
import { CourierResolver } from './graphql/couriers.resolver.js';
import { CourierPickupResolver } from './graphql/pickups.resolver.js';
import { CodRemittanceResolver } from './graphql/remittance.resolver.js';
import { CourierPickupService } from './pickups.service.js';
import { CodRemittanceService } from './remittance.service.js';

/**
 * Fulfillment and logistics: couriers' remittance statements, their cash received on orders
 * through the orders module's functions; the shop's courier accounts, its orders' bookings with
 * them, the couriers' names for the cities its parcels go to, pickups through couriers' APIs, and
 * the rules that choose which account books an order.
 * Needs the {@link Database} and {@link SecretBox} providers from the host application, and
 * {@link ObjectStorage} for couriers' load sheets if they are to be kept; and the couriers shops
 * can book with: Leopards and PostEx unless given.
 */
@Module({})
export class LogisticsModule {
  static forRoot(options: { couriers?: Couriers } = {}): DynamicModule {
    return {
      module: LogisticsModule,
      // Labels say where parcels come from: the inventory module's locations.
      imports: [InventoryModule],
      providers: [
        {
          provide: COURIERS,
          useValue: options.couriers ?? new Couriers([new LeopardsCourier(), new PostExCourier()]),
        },
        CodRemittanceService,
        CodRemittanceResolver,
        CourierAccountService,
        CourierBookingService,
        CourierCityService,
        CourierDocumentService,
        CourierPickupResolver,
        CourierPickupService,
        CourierResolver,
        CourierRuleResolver,
        CourierRuleService,
      ],
      exports: [
        CodRemittanceService,
        CourierAccountService,
        CourierBookingService,
        CourierCityService,
        CourierDocumentService,
        CourierPickupService,
        CourierRuleService,
      ],
    };
  }
}

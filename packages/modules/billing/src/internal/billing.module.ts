import { PlanAllowance } from '@hatti/api';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { BillingPagesController, BillingWebhookController } from './billing.controller.js';
import { BILLING_GATEWAY, BillingService, type HattiGateway } from './billing.service.js';
import { BillingResolver } from './graphql/billing.resolver.js';

/**
 * What shops pay Hatti (BIL-01, ADR-154). Global, as it gives other modules {@link PlanAllowance}:
 * the limits of each shop's plan. Needs the {@link Database} and PublicSite providers from the
 * host application, which keeps each webhook request's raw body as `rawBody`; and Hatti's own
 * gateway account, without which invoices are not paid online here.
 */
@Global()
@Module({})
export class BillingModule {
  static forRoot(options: { gateway?: HattiGateway | null } = {}): DynamicModule {
    return {
      module: BillingModule,
      controllers: [BillingPagesController, BillingWebhookController],
      providers: [
        { provide: BILLING_GATEWAY, useValue: options.gateway ?? null },
        BillingService,
        { provide: PlanAllowance, useExisting: BillingService },
        BillingResolver,
      ],
      exports: [BillingService, PlanAllowance],
    };
  }
}

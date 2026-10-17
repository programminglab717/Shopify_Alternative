import { AiCredits, PlanAllowance } from '@hatti/api';
import { MessageCharges } from '@hatti/messaging/public';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AiCreditsService } from './ai-credits.js';
import { BillingPagesController, BillingWebhookController } from './billing.controller.js';
import {
  BILLING_BANK_ACCOUNT,
  BILLING_GATEWAY,
  BillingService,
  type HattiBankAccount,
  type HattiGateway,
} from './billing.service.js';
import { BILLING_TAX, type HattiTax } from './tax.js';
import { MessageWallet } from './credits.js';
import { BillingResolver } from './graphql/billing.resolver.js';
import { SupportResolver } from './graphql/support.resolver.js';
import { SUPPORT_CONTACT, SupportService, type SupportContact } from './support.service.js';

/**
 * What shops pay Hatti (BIL-01, BIL-03, ADR-154, ADR-155). Global, as it gives other modules
 * {@link PlanAllowance}, the limits of each shop's plan, {@link MessageCharges}, the credit
 * its messages are paid from, and {@link AiCredits}, the AI drafts its plan includes a month. Needs the {@link Database} and PublicSite providers from the host
 * application, which keeps each webhook request's raw body as `rawBody`; Hatti's own gateway
 * account, without which invoices are not paid online here; and Hatti's own bank account, without
 * which they are not paid by transfer (ADR-254); Hatti's registration for sales tax on services,
 * without which invoices carry none (ADR-512); and Hatti's support lines, without which shops
 * reach Hatti's people by requests from the admin alone (ADR-508).
 */
@Global()
@Module({})
export class BillingModule {
  static forRoot(
    options: {
      gateway?: HattiGateway | null;
      bankAccount?: HattiBankAccount | null;
      tax?: HattiTax | null;
      support?: SupportContact | null;
    } = {},
  ): DynamicModule {
    return {
      module: BillingModule,
      controllers: [BillingPagesController, BillingWebhookController],
      providers: [
        { provide: BILLING_GATEWAY, useValue: options.gateway ?? null },
        { provide: BILLING_BANK_ACCOUNT, useValue: options.bankAccount ?? null },
        { provide: BILLING_TAX, useValue: options.tax ?? null },
        { provide: SUPPORT_CONTACT, useValue: options.support ?? null },
        BillingService,
        { provide: PlanAllowance, useExisting: BillingService },
        MessageWallet,
        { provide: MessageCharges, useExisting: MessageWallet },
        AiCreditsService,
        { provide: AiCredits, useExisting: AiCreditsService },
        BillingResolver,
        SupportService,
        SupportResolver,
      ],
      exports: [
        BillingService,
        PlanAllowance,
        MessageWallet,
        MessageCharges,
        AiCreditsService,
        AiCredits,
        SupportService,
      ],
    };
  }
}

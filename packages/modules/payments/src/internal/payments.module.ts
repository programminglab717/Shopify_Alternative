import { OnlinePayments } from '@hatti/orders/public';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { GatewayAccountService, PAYMENT_GATEWAYS } from './gateway-accounts.service.js';
import { PaymentGateways, SafepayGateway } from './gateways.js';
import { PaymentsResolver } from './graphql/payments.resolver.js';
import { OnlinePaymentService } from './online-payment.service.js';
import { PaymentWebhookController } from './webhooks.controller.js';

/**
 * Payments online through the shop's own gateway accounts (PAY-01, PAY-04, ADR-151). Global, as
 * it gives the orders module {@link OnlinePayments}: orders' pages take what an order waits for
 * through it. Needs the {@link Database}, {@link SecretBox} and PublicSite providers from the host
 * application, which keeps each webhook request's raw body as `rawBody`; and the gateways shops
 * can take payments through: Safepay unless given.
 */
@Global()
@Module({})
export class PaymentsModule {
  static forRoot(options: { gateways?: PaymentGateways } = {}): DynamicModule {
    return {
      module: PaymentsModule,
      controllers: [PaymentWebhookController],
      providers: [
        {
          provide: PAYMENT_GATEWAYS,
          useValue: options.gateways ?? new PaymentGateways([new SafepayGateway()]),
        },
        GatewayAccountService,
        OnlinePaymentService,
        { provide: OnlinePayments, useExisting: OnlinePaymentService },
        PaymentsResolver,
      ],
      exports: [GatewayAccountService, OnlinePaymentService, OnlinePayments],
    };
  }
}

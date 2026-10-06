import {
  BaadmayGateway,
  EasypaisaGateway,
  JazzCashGateway,
  PaymentGateways,
  SafepayGateway,
  TestGateway,
} from '@hatti/payments/public';

/**
 * The payment gateways shops take payments online through here (ADR-151, ADR-163, ADR-214,
 * ADR-226): Safepay, JazzCash, Easypaisa and Baadmay's buy now, pay later; and, outside
 * production, the test gateway, which takes nothing.
 */
export function paymentGatewaysOf(options: { production: boolean }): PaymentGateways {
  return new PaymentGateways([
    new BaadmayGateway(),
    new EasypaisaGateway(),
    new JazzCashGateway(),
    new SafepayGateway(),
    ...(options.production ? [] : [new TestGateway()]),
  ]);
}

import {
  AlfalahGateway,
  BaadmayGateway,
  EasypaisaGateway,
  JazzCashGateway,
  PayFastGateway,
  PaymentGateways,
  SafepayGateway,
  TestGateway,
} from '@hatti/payments/public';

/**
 * The payment gateways shops take payments online through here (ADR-151, ADR-163, ADR-214,
 * ADR-226, ADR-227, ADR-228): Safepay, JazzCash, Easypaisa, PayFast, Bank Alfalah's and Baadmay's
 * buy now, pay later; and, outside production, the test gateway, which takes nothing.
 */
export function paymentGatewaysOf(options: { production: boolean }): PaymentGateways {
  return new PaymentGateways([
    new AlfalahGateway(),
    new BaadmayGateway(),
    new EasypaisaGateway(),
    new JazzCashGateway(),
    new PayFastGateway(),
    new SafepayGateway(),
    ...(options.production ? [] : [new TestGateway()]),
  ]);
}

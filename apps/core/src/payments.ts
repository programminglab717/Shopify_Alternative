import {
  AlfalahGateway,
  BaadmayGateway,
  EasypaisaGateway,
  HblGateway,
  JazzCashGateway,
  PayFastGateway,
  PaymentGateways,
  SafepayGateway,
  TestGateway,
} from '@hatti/payments/public';

/**
 * The payment gateways shops take payments online through here (ADR-151, ADR-163, ADR-214,
 * ADR-226 to ADR-229): Safepay, JazzCash, Easypaisa, PayFast, Bank Alfalah's, HBL's and Baadmay's
 * buy now, pay later; and, outside production, the test gateway, which takes nothing.
 */
export function paymentGatewaysOf(options: { production: boolean }): PaymentGateways {
  return new PaymentGateways([
    new AlfalahGateway(),
    new BaadmayGateway(),
    new EasypaisaGateway(),
    new HblGateway(),
    new JazzCashGateway(),
    new PayFastGateway(),
    new SafepayGateway(),
    ...(options.production ? [] : [new TestGateway()]),
  ]);
}

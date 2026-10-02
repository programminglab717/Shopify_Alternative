import { PaymentGateways, SafepayGateway, TestGateway } from '@hatti/payments/public';

/**
 * The payment gateways shops take payments online through here (ADR-151): Safepay; and, outside
 * production, the test gateway, which takes nothing.
 */
export function paymentGatewaysOf(options: { production: boolean }): PaymentGateways {
  return new PaymentGateways([
    new SafepayGateway(),
    ...(options.production ? [] : [new TestGateway()]),
  ]);
}

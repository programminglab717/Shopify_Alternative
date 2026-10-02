import type { HattiGateway } from '@hatti/billing/public';
import { SafepayGateway, TestGateway } from '@hatti/payments/public';
import type { ApiConfig } from './config.js';

/**
 * Hatti's own account with a payment gateway, which shops pay their plans through (ADR-154):
 * Safepay, with the credentials of Hatti's own Safepay account where they are set; outside
 * production, the test gateway, which takes nothing; and none otherwise, so that invoices are not
 * paid online.
 */
export function hattiGatewayOf(
  config: Pick<
    ApiConfig,
    | 'NODE_ENV'
    | 'BILLING_SAFEPAY_ENVIRONMENT'
    | 'BILLING_SAFEPAY_API_KEY'
    | 'BILLING_SAFEPAY_SECRET_KEY'
    | 'BILLING_SAFEPAY_WEBHOOK_SECRET'
  >,
): HattiGateway | null {
  if (
    config.BILLING_SAFEPAY_API_KEY &&
    config.BILLING_SAFEPAY_SECRET_KEY &&
    config.BILLING_SAFEPAY_WEBHOOK_SECRET
  ) {
    return {
      gateway: new SafepayGateway(),
      account: {
        environment: config.BILLING_SAFEPAY_ENVIRONMENT,
        credentials: {
          apiKey: config.BILLING_SAFEPAY_API_KEY,
          secretKey: config.BILLING_SAFEPAY_SECRET_KEY,
          webhookSecret: config.BILLING_SAFEPAY_WEBHOOK_SECRET,
        },
      },
    };
  }
  if (config.NODE_ENV === 'production') return null;
  return {
    gateway: new TestGateway(),
    account: { environment: 'production', credentials: { secret: 'hatti-billing-local' } },
  };
}

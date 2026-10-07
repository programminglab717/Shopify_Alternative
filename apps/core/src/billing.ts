import type { HattiBankAccount, HattiGateway } from '@hatti/billing/public';
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

/**
 * Hatti's own bank account, which shops pay invoices into by transfer or Raast (ADR-254), where
 * it is set; none otherwise, so that invoices are not paid by transfer.
 */
export function hattiBankAccountOf(
  config: Pick<
    ApiConfig,
    'BILLING_BANK_TITLE' | 'BILLING_BANK_NAME' | 'BILLING_BANK_IBAN' | 'BILLING_RAAST_ID'
  >,
): HattiBankAccount | null {
  if (!config.BILLING_BANK_TITLE || !config.BILLING_BANK_NAME || !config.BILLING_BANK_IBAN) {
    return null;
  }
  return {
    title: config.BILLING_BANK_TITLE,
    bankName: config.BILLING_BANK_NAME,
    iban: config.BILLING_BANK_IBAN,
    raastId: config.BILLING_RAAST_ID ?? null,
  };
}

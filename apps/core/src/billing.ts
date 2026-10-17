import {
  SERVICE_TAX_RATES,
  cloudSupportSender,
  type HattiBankAccount,
  type HattiGateway,
  type HattiTax,
  type SupportContact,
  type SupportWhatsAppSender,
} from '@hatti/billing/public';
import type { SupportLineSettings } from '@hatti/messaging/public';
import { SafepayGateway, TestGateway } from '@hatti/payments/public';
import type { ApiConfig, SupportRequestsConfig } from './config.js';

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

/**
 * Hatti's own support lines (ADR-508), shown to shops as their plans allow; none where none is
 * set, so that shops send requests from the admin alone.
 */
export function supportContactOf(
  config: Pick<
    ApiConfig,
    'SUPPORT_WHATSAPP' | 'SUPPORT_PHONE' | 'SUPPORT_EMAIL' | 'SUPPORT_HOURS' | 'SUPPORT_HOURS_UR'
  >,
): SupportContact | null {
  const contact: SupportContact = {
    whatsapp: config.SUPPORT_WHATSAPP ?? null,
    phone: config.SUPPORT_PHONE ?? null,
    email: config.SUPPORT_EMAIL ?? null,
    hours:
      config.SUPPORT_HOURS && config.SUPPORT_HOURS_UR
        ? { en: config.SUPPORT_HOURS, ur: config.SUPPORT_HOURS_UR }
        : null,
  };
  return Object.values(contact).some((value) => value !== null) ? contact : null;
}

/**
 * Hatti's support WhatsApp number (ADR-560), where it is set: what shops' staff write to it is
 * kept as their shops' support requests; none otherwise.
 */
export function supportLineOf(
  config: Pick<ApiConfig, 'SUPPORT_WHATSAPP_PHONE_NUMBER_ID'>,
): SupportLineSettings | null {
  return config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    ? { phoneNumberId: config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID }
    : null;
}

/**
 * How Hatti's people's answers go back on WhatsApp (ADR-560): from Hatti's support number, on
 * Meta's Graph API, where it is set; none otherwise, so that answers are shown in the admin alone.
 */
export function supportSenderOf(
  config: Pick<
    SupportRequestsConfig,
    | 'META_GRAPH_URL'
    | 'META_GRAPH_VERSION'
    | 'SUPPORT_WHATSAPP_PHONE_NUMBER_ID'
    | 'SUPPORT_WHATSAPP_ACCESS_TOKEN'
  >,
): SupportWhatsAppSender | null {
  if (!config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID || !config.SUPPORT_WHATSAPP_ACCESS_TOKEN) {
    return null;
  }
  return cloudSupportSender({
    baseUrl: config.META_GRAPH_URL,
    version: config.META_GRAPH_VERSION,
    phoneNumberId: config.SUPPORT_WHATSAPP_PHONE_NUMBER_ID,
    accessToken: config.SUPPORT_WHATSAPP_ACCESS_TOKEN,
  });
}

/**
 * Hatti's registration for sales tax on services (ADR-512), where it is set: at the authority's
 * standard rate unless another is given; none otherwise, so that invoices carry no tax.
 */
export function hattiTaxOf(
  config: Pick<
    ApiConfig,
    'BILLING_TAX_AUTHORITY' | 'BILLING_TAX_REGISTRATION' | 'BILLING_TAX_RATE' | 'BILLING_NTN'
  >,
): HattiTax | null {
  if (!config.BILLING_TAX_AUTHORITY || !config.BILLING_TAX_REGISTRATION) return null;
  return {
    authority: config.BILLING_TAX_AUTHORITY,
    registration: config.BILLING_TAX_REGISTRATION,
    rate:
      config.BILLING_TAX_RATE === undefined
        ? SERVICE_TAX_RATES[config.BILLING_TAX_AUTHORITY]
        : Math.round(config.BILLING_TAX_RATE * 100),
    ntn: config.BILLING_NTN ?? null,
  };
}

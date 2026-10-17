// The billing module's public surface. Everything under src/internal is private to this module.
export {
  CREDIT_LIMITS,
  MESSAGE_FEES,
  MESSAGE_RATES,
  MessageWallet,
  WALLET_ENTRY_KINDS,
  messagePriceOf,
  type WalletEntryKind,
  type WalletEntryRecord,
} from '../internal/credits.js';
export {
  BillingEvents,
  type CreditLowPayload,
  type InvoicePayload,
  type InvoiceTransferPayload,
  type PaymentOverduePayload,
  type SubscriptionChangedPayload,
} from '../internal/events.js';
export {
  BILLING_BANK_ACCOUNT,
  BILLING_GATEWAY,
  BILLING_PATH,
  BILLING_WEBHOOK_PATH,
  BillingService,
  INVOICE_STATUSES,
  TRANSFER_REFERENCE,
  TRANSFER_REFUSAL_LENGTH,
  type HattiBankAccount,
  type HattiGateway,
  type InvoicePageView,
  type InvoiceRecord,
  type InvoiceStatusValue,
  type InvoiceTransferRecord,
  type MessagePriceRecord,
  type SubscriptionRecord,
  type TransferChecked,
  type TransferStatusValue,
  type WaitingTransferRecord,
  type WalletRecord,
} from '../internal/billing.service.js';
export { invoicePage } from '../internal/billing-pages.js';
export { BillingModule } from '../internal/billing.module.js';
export { AI_CREDIT_PACK, AiCreditsService, creditMonth } from '../internal/ai-credits.js';
export {
  BILLING_CURRENCY,
  BILLING_INTERVALS,
  BILLING_LIMITS,
  PLANS,
  PLAN_CODES,
  beginsAtOnce,
  invoiceName,
  monthlyValue,
  periodEndOf,
  type BillingIntervalValue,
  type Plan,
  type PlanCode,
} from '../internal/plans.js';
export {
  SUPPORT_CONTACT,
  SUPPORT_LIMITS,
  SUPPORT_TIERS,
  SUPPORT_TOPICS,
  SupportService,
  supportDueAt,
  type OpenSupportRequest,
  type SupportChannel,
  type SupportContact,
  type SupportRecord,
  type SupportRequestRecord,
  type SupportTier,
  type SupportTopic,
} from '../internal/support.service.js';
export {
  BILLING_TAX,
  SERVICE_TAX_RATES,
  TAX_AUTHORITIES,
  taxOn,
  type HattiTax,
  type TaxAuthority,
} from '../internal/tax.js';

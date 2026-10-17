// The tax module's public surface. Everything under src/internal is private to this module.
export {
  TaxEvents,
  type FbrPosDeletedPayload,
  type FbrPosUpdatedPayload,
  type TaxSettingsUpdatedPayload,
} from '../internal/events.js';
export {
  FbrPosClient,
  type FbrPosConnection,
  type FbrPosOptions,
  type FbrReportResult,
} from '../internal/fbr-client.js';
export {
  FbrDigitalInvoicingClient,
  type FbrDigitalInvoicingConnection,
  type FbrDigitalInvoicingOptions,
} from '../internal/fbr-di-client.js';
export {
  DI_NO_CREDIT_NOTES,
  DI_SANDBOX_SCENARIO,
  FBR_DI_URLS,
  diInvoiceBody,
  diInvoiceRequest,
  type DiInvoiceBody,
  type DiInvoiceRequest,
  type DiItemBody,
  type DiSeller,
} from '../internal/fbr-di.js';
export {
  FbrPosService,
  FiscalInvoicesService,
  fiscalInvoicesIn,
  recordFiscalDocumentsIn,
  type ClaimedFiscalInvoice,
  type FbrConnection,
  type FbrPosInput,
  type FbrPosRecord,
  type FiscalInvoiceRecord,
  type FiscalOutcome,
} from '../internal/fbr-pos.service.js';
export {
  FBR_ENVIRONMENTS,
  FBR_SYSTEMS,
  fbrDateTime,
  fbrInvoiceBody,
  fbrInvoiceRequest,
  type FbrEnvironment,
  type FbrInvoiceBody,
  type FbrInvoiceRequest,
  type FbrSystem,
  type FiscalBuyer,
  type FiscalDocument,
  type FiscalItem,
  type FiscalKind,
  type FiscalPaymentMode,
  type FiscalStatus,
} from '../internal/fbr.js';
export { FiscalInvoiceStatus } from '../internal/graphql/fbr.types.js';
export { TaxCategory, TaxLine, TaxSettings, toTaxLine } from '../internal/graphql/tax.types.js';
export {
  TaxSettingsService,
  taxSettingsIn,
  type TaxSettingsInput,
} from '../internal/tax-settings.service.js';
export { TaxModule } from '../internal/tax.module.js';
export {
  FILER_STATUSES,
  NO_TAX,
  SALES_TAX,
  TAX_GUIDANCE,
  TAX_PROVINCES,
  taxGuidance,
  withholdingRates,
  type FilerStatus,
  type TaxGuidanceCode,
  type TaxProvince,
  TAX_CODE,
  TAX_LIMITS,
  discountShares,
  includedTax,
  lineRateOf,
  orderTaxOf,
  ratePercent,
  taxIncludedWords,
  taxesByRate,
  type OrderTax,
  type TaxCategoryInput,
  type TaxCategoryValue,
  type TaxRates,
  type TaxSettingsRecord,
  type TaxedAmounts,
} from '../internal/tax.js';

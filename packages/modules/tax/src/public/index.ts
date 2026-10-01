// The tax module's public surface. Everything under src/internal is private to this module.
export { TaxEvents, type TaxSettingsUpdatedPayload } from '../internal/events.js';
export { TaxCategory, TaxLine, TaxSettings, toTaxLine } from '../internal/graphql/tax.types.js';
export {
  TaxSettingsService,
  taxSettingsIn,
  type TaxSettingsInput,
} from '../internal/tax-settings.service.js';
export { TaxModule } from '../internal/tax.module.js';
export {
  NO_TAX,
  SALES_TAX,
  TAX_CODE,
  TAX_LIMITS,
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

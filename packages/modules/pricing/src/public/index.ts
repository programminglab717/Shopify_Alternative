// The pricing module's public surface. Everything under src/internal is private to this module.
export {
  AUTOMATIC_DISCOUNT_LIMIT,
  AutomaticDiscountService,
  runningAutomaticDiscountsIn,
  type AutomaticDiscountInput,
} from '../internal/automatic-discount.service.js';
export { NO_DISCOUNTS, chooseDiscounts, type ChosenDiscounts } from '../internal/combining.js';
export { DISCOUNT_CUSTOMER_DATA } from '../internal/customer-data.js';
export {
  DiscountCodeService,
  discountCodeByIdIn,
  discountCodeIn,
  type DiscountCodeInput,
} from '../internal/discount-code.service.js';
export {
  DISCOUNT_CODE,
  DISCOUNT_CODE_LIMIT,
  automaticSummary,
  discountOf,
  discountStatus,
  discountSummary,
  discountValueText,
  typedCode,
  type DiscountAmounts,
} from '../internal/discounts.js';
export {
  PricingEvents,
  type AutomaticDiscountChangedPayload,
  type DiscountCodeChangedPayload,
  type DiscountCodeRedeemedPayload,
} from '../internal/events.js';
export { AutomaticDiscount } from '../internal/graphql/automatic-discount.types.js';
export { toAutomaticDiscount } from '../internal/graphql/automatic-discount.resolver.js';
export { DiscountCode } from '../internal/graphql/discount-code.types.js';
export { toDiscountCode } from '../internal/graphql/discount-code.resolver.js';
export { PricingModule } from '../internal/pricing.module.js';
export type {
  AutomaticDiscountRecord,
  DiscountCodeRecord,
  DiscountStatusValue,
} from '../internal/records.js';
export {
  applyDiscountIn,
  discountFor,
  redeemDiscountIn,
  type AppliedDiscount,
  type DiscountRefusal,
} from '../internal/redemptions.js';
export { DISCOUNT_KINDS, type DiscountKindValue } from '../internal/schema.js';

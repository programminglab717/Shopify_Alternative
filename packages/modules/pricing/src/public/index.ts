// The pricing module's public surface. Everything under src/internal is private to this module.
export { DISCOUNT_CUSTOMER_DATA } from '../internal/customer-data.js';
export {
  DiscountCodeService,
  discountCodeIn,
  type DiscountCodeInput,
} from '../internal/discount-code.service.js';
export {
  DISCOUNT_CODE,
  DISCOUNT_CODE_LIMIT,
  discountOf,
  discountStatus,
  discountSummary,
  typedCode,
  type DiscountAmounts,
} from '../internal/discounts.js';
export {
  PricingEvents,
  type DiscountCodeChangedPayload,
  type DiscountCodeRedeemedPayload,
} from '../internal/events.js';
export { DiscountCode } from '../internal/graphql/discount-code.types.js';
export { toDiscountCode } from '../internal/graphql/discount-code.resolver.js';
export { PricingModule } from '../internal/pricing.module.js';
export type { DiscountCodeRecord, DiscountStatusValue } from '../internal/records.js';
export {
  applyDiscountIn,
  discountFor,
  redeemDiscountIn,
  type AppliedDiscount,
  type DiscountRefusal,
} from '../internal/redemptions.js';
export { DISCOUNT_KINDS, type DiscountKindValue } from '../internal/schema.js';

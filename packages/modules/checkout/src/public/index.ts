// The checkout module's public surface. Everything under src/internal is private to this module.
export {
  CART_DAYS,
  CART_LIMITS,
  lineKey,
  type CartAction,
  type StoredLine,
} from '../internal/cart-lines.js';
export { CartService, type CartResult } from '../internal/cart.service.js';
export { CheckoutModule } from '../internal/checkout.module.js';
export { CHECKOUT_CUSTOMER_DATA, CheckoutCustomerData } from '../internal/customer-data.js';
export {
  COD_RULE_LIMITS,
  type CodRefusal,
  type CodRulesInput,
  type CodRulesRecord,
} from '../internal/cod-rules.js';
export { CodRulesService, codRulesIn } from '../internal/cod-rules.service.js';
export {
  CHECKOUT_HOURS,
  CHECKOUT_PATH,
  CheckoutService,
  type CheckoutForm,
  type CheckoutView,
} from '../internal/checkout.service.js';
export {
  DELIVERY_LIMITS,
  deliveryCharge,
  type DeliverySettingsInput,
  type DeliverySettingsRecord,
  type DeliveryZoneInput,
  type DeliveryZoneRecord,
} from '../internal/delivery.js';
export { DeliveryService } from '../internal/delivery.service.js';
export {
  CheckoutEvents,
  type CodSettingsUpdatedPayload,
  type DeliverySettingsUpdatedPayload,
  type MarketingOptionsUpdatedPayload,
  type TrustBadgesUpdatedPayload,
} from '../internal/events.js';
export { DEFAULT_MARKETING_CHANNELS, MARKETING_FIELDS } from '../internal/marketing.js';
export { CheckoutMarketingService, checkoutMarketingIn } from '../internal/marketing.service.js';
export { TrustBadgeService, trustBadgesIn } from '../internal/trust-badge.service.js';
export {
  TRUST_BADGE_KINDS,
  TRUST_BADGE_LIMITS,
  type TrustBadgeInput,
  type TrustBadgeKind,
  type TrustBadgeValue,
} from '../internal/trust-badges.js';

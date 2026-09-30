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

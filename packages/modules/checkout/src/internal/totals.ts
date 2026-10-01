import { discountOf, type DiscountCodeRecord } from '@hatti/pricing/public';
import { deliveryCharge, type DeliverySettingsRecord } from './delivery.js';

/** What a checkout comes to, in minor units, as its page shows it and its order is placed. */
export interface CheckoutTotals {
  subtotal: bigint;
  /** Off the items, by the discount code. */
  discount: bigint;
  /**
   * What delivery costs before the code: null until a city is given, when cities' charges differ,
   * unless a free-delivery code makes it free wherever it goes.
   */
  delivery: bigint | null;
  /** Whether a discount code makes delivery free. */
  freeDelivery: boolean;
  /** Null while delivery is not known. */
  total: bigint | null;
}

/**
 * What `subtotal` of items comes to with the shop's delivery `settings` to `city`, the discount
 * code `code` applied: the code first, then delivery, whose free threshold the discounted items
 * must reach, as Shopify's free shipping does.
 */
export function checkoutTotals(
  subtotal: bigint,
  settings: DeliverySettingsRecord,
  city: string | null,
  code: DiscountCodeRecord | null,
): CheckoutTotals {
  const discount = code ? discountOf(code, { subtotal, shipping: 0n }).items : 0n;
  const items = subtotal - discount;
  const typed = city?.trim() || null;
  const free = settings.freeAbove !== null && items >= settings.freeAbove;
  const delivery =
    free || settings.zones.length === 0 || typed !== null
      ? deliveryCharge(settings, typed, items)
      : null;
  const freeDelivery = code?.kind === 'free_shipping';
  if (freeDelivery) return { subtotal, discount, delivery, freeDelivery, total: items };
  return {
    subtotal,
    discount,
    delivery,
    freeDelivery,
    total: delivery === null ? null : items + delivery,
  };
}

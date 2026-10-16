// Back in stock (ADR-429): a shopper who finds a variant sold out on the storefront leaves their
// mobile number, which the storefront sends on to the core, to hear on WhatsApp, once, when the
// variant is for sale online again.

import { STOREFRONT_API_PREFIX } from './cart.js';

/**
 * POST a {@link StockWatchRequest}: a shopper's wish, answered with a {@link StockWatchResponse};
 * 422, with a {@link StockWatchErrorResponse}, says what was wrong with it.
 */
export function stockWatchesPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/stock-watches`;
}

export interface StockWatchRequest {
  /** The variant the shopper found sold out: `contact[variant_id]`. */
  variantId: string;
  /** The mobile number typed: `contact[phone]`. */
  phone: string;
  /** The storefront's language the page was in. */
  language: 'en' | 'ur';
}

export interface StockWatchResponse {
  /** Whether the number was not waiting for the variant already. */
  created: boolean;
}

/**
 * What was wrong with a wish, by field: "phone", "variant" for one the shop does not sell, or
 * "base" while the shop does not send these messages.
 */
export interface StockWatchErrorResponse {
  errors: { field: string; message: string }[];
}

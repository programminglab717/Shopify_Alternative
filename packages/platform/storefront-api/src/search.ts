// Search, as storefronts ask the core for it (ADR-046): a shop's active products with every word
// of what the shopper typed, best first, found in the catalog as the admin's search finds them.

import { STOREFRONT_API_PREFIX } from './cart.js';

/** GET `…/search?q=`: what a search finds. */
export function searchPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/search`;
}

/** The most products a search finds; a storefront shows a page of them at a time. */
export const SEARCH_RESULTS = 250;

/** The most of what a shopper typed that a search reads. */
export const SEARCH_TERMS_MAX = 200;

/** The products found, best first, by the IDs their documents have. */
export interface SearchResponse {
  productIds: string[];
}

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

/** How a search reads what was typed, and how much it finds. */
export interface SearchOptions {
  /** "last": the last word may be cut short, as it is while a shopper types. */
  prefix?: 'last' | 'none';
  /** The most products to find, up to {@link SEARCH_RESULTS}. */
  limit?: number;
}

/** The query of a search's request: `q`, and `prefix` and `limit` when they are asked for. */
export function searchQuery(terms: string, options: SearchOptions = {}): URLSearchParams {
  const query = new URLSearchParams({ q: terms.slice(0, SEARCH_TERMS_MAX) });
  if (options.prefix === 'last') query.set('prefix', 'last');
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  return query;
}

/** The products found, best first, by the IDs their documents have. */
export interface SearchResponse {
  productIds: string[];
}

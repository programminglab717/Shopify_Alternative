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

/** GET `…/search/content?q=`: the shop's articles and pages a search finds (ADR-212). */
export function contentSearchPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/search/content`;
}

/** What a search may find beside products, as Shopify's search `type` names them. */
export const CONTENT_TYPES = ['article', 'page'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** How a search of the shop's articles and pages reads what was typed, and what it finds. */
export interface ContentSearchOptions extends SearchOptions {
  /** The kinds to find, each up to `limit`; both when not said. */
  types?: readonly ContentType[];
}

/** The query of a content search's request: a search's, and `types` when they are asked for. */
export function contentSearchQuery(
  terms: string,
  options: ContentSearchOptions = {},
): URLSearchParams {
  const query = searchQuery(terms, options);
  if (options.types) query.set('types', options.types.join(','));
  return query;
}

/** The published articles and pages found, best first, each kind by its documents' IDs. */
export interface ContentSearchResponse {
  articleIds: string[];
  pageIds: string[];
}

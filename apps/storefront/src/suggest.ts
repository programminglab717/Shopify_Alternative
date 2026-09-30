import { SEARCH_TERMS_MAX } from '@hatti/storefront-api';
import type { ImageDoc, ProductDoc } from '@hatti/storefront-data';

// Shopify's predictive search (ADR-046): the products that could be what a shopper is typing, a
// few at a time, found by the core as the search page finds them, the last word taken as cut
// short. /search/suggest.json gives them as JSON; /search/suggest?section_id= renders a section
// of the theme's with them, as `predictive_search`.

/** What Shopify's predictive search can be asked for. Hatti finds products alone, so far. */
const TYPES = ['query', 'product', 'collection', 'page', 'article'] as const;
export type SuggestType = (typeof TYPES)[number];

/** Shopify's names for each kind's results. */
const RESULTS: Readonly<Record<SuggestType, string>> = {
  query: 'queries',
  product: 'products',
  collection: 'collections',
  page: 'pages',
  article: 'articles',
};

/** The most suggestions a request may ask for, as on Shopify. */
export const SUGGEST_LIMIT = 10;

export interface SuggestParams {
  /** What the shopper has typed so far. */
  terms: string;
  types: SuggestType[];
  limit: number;
  /** Products none of whose variants can be bought: where they fall, left out, or after the rest. */
  unavailable: 'show' | 'hide' | 'last';
}

/** A predictive search's parameters, from its request's query, as Shopify reads them. */
export function suggestParams(query: URLSearchParams): SuggestParams {
  const asked = (query.get('resources[type]') ?? 'query,product,collection,page').split(',');
  const types = TYPES.filter((type) => asked.some((each) => each.trim() === type));
  const limit = query.get('resources[limit]') ?? '';
  const unavailable = query.get('resources[options][unavailable_products]');
  return {
    terms: (query.get('q') ?? '').trim().slice(0, SEARCH_TERMS_MAX),
    types,
    limit: /^\d{1,3}$/.test(limit)
      ? Math.min(Math.max(Number(limit), 1), SUGGEST_LIMIT)
      : SUGGEST_LIMIT,
    unavailable: unavailable === 'show' || unavailable === 'hide' ? unavailable : 'last',
  };
}

/**
 * How many products to ask the core for: twice as many as are shown when those that cannot be
 * bought are left out or put last, so that others can take their places.
 */
export function suggestWanted(params: SuggestParams): number {
  if (!params.types.includes('product') || params.terms === '') return 0;
  return params.unavailable === 'show' ? params.limit : params.limit * 2;
}

/** The products to suggest, best first, as `params.unavailable` orders them: at most its limit. */
export function suggestedProducts(
  docs: readonly (ProductDoc | null)[],
  params: SuggestParams,
): ProductDoc[] {
  const found = docs.filter((doc): doc is ProductDoc => doc !== null);
  const ordered =
    params.unavailable === 'show'
      ? found
      : [
          ...found.filter(isAvailable),
          ...(params.unavailable === 'last' ? found.filter((doc) => !isAvailable(doc)) : []),
        ];
  return ordered.slice(0, params.limit);
}

/** /search/suggest.json's answer: the products found, and nothing yet of the other kinds asked. */
export function suggestJson(
  params: SuggestParams,
  products: readonly ProductDoc[],
): { resources: { results: Record<string, unknown[]> } } {
  const results: Record<string, unknown[]> = {};
  for (const type of params.types) {
    results[RESULTS[type]] = type === 'product' ? products.map(productJson) : [];
  }
  return { resources: { results } };
}

function isAvailable(doc: ProductDoc): boolean {
  return doc.variants.some((variant) => variant.available);
}

/** A product as Shopify's predictive search gives it: amounts in rupees, as "2500.00". */
function productJson(doc: ProductDoc): Record<string, unknown> {
  const url = `/products/${doc.handle}`;
  const prices = doc.variants.map((variant) => variant.price);
  const compared = doc.variants.map((variant) => variant.compareAtPrice ?? 0);
  const image = doc.images[0] ?? null;
  return {
    id: doc.id,
    title: doc.title,
    handle: doc.handle,
    url,
    body: doc.descriptionHtml,
    vendor: doc.vendor,
    type: doc.productType,
    tags: doc.tags,
    available: isAvailable(doc),
    price: rupees(Math.min(...prices, Infinity)),
    price_min: rupees(Math.min(...prices, Infinity)),
    price_max: rupees(Math.max(...prices, 0)),
    compare_at_price_min: rupees(Math.min(...compared, Infinity)),
    compare_at_price_max: rupees(Math.max(...compared, 0)),
    image: image?.src ?? null,
    featured_image: image && imageJson(image),
    variants: doc.variants.map((variant) => {
      const own = variant.image === null ? null : (doc.images[variant.image] ?? null);
      return {
        id: variant.id,
        title: variant.title,
        sku: variant.sku ?? '',
        available: variant.available,
        price: rupees(variant.price),
        compare_at_price: variant.compareAtPrice === null ? null : rupees(variant.compareAtPrice),
        url: `${url}?variant=${encodeURIComponent(variant.id)}`,
        image: own?.src ?? null,
        featured_image: own && imageJson(own),
      };
    }),
  };
}

function imageJson(image: ImageDoc): Record<string, unknown> {
  return {
    url: image.src,
    alt: image.alt ?? '',
    width: image.width,
    height: image.height,
    aspect_ratio: image.width > 0 && image.height > 0 ? image.width / image.height : null,
  };
}

/** Paisa as Shopify's JSON writes amounts, in rupees with two places: 250000 → "2500.00". */
function rupees(paisa: number): string {
  const amount = Number.isFinite(paisa) ? paisa : 0;
  return `${Math.trunc(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

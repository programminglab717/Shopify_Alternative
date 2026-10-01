import { parseSearch, type SearchFilter, type SearchParse, type SearchSyntax } from '@hatti/api';
import { searchKey } from '@hatti/pk';
import { sql, type SQL } from 'drizzle-orm';
import { PRODUCT_STATUSES } from './schema.js';

/**
 * The filters a products search may name, as Shopify's search syntax writes them (`key:value`),
 * with the values each takes: a status one of the three, every other filter any value, matched in
 * any letter case (ADR-120).
 */
export const PRODUCT_SEARCH_FILTERS = {
  status: PRODUCT_STATUSES,
  vendor: null,
  product_type: null,
  tag: null,
  sku: null,
  barcode: null,
  handle: null,
} as const satisfies Record<string, readonly string[] | null>;

export type ProductSearchKey = keyof typeof PRODUCT_SEARCH_FILTERS;

const PRODUCT_SEARCH: SearchSyntax<ProductSearchKey> = {
  noun: 'Products',
  filters: PRODUCT_SEARCH_FILTERS,
  examples: {
    vendor: 'Khaadi',
    product_type: 'Kurta',
    tag: 'eid',
    sku: 'KRT-001',
    barcode: '8964000000001',
    handle: 'lawn-kurta',
  },
};

/**
 * A products search as Shopify's search syntax writes it (ADR-120): filters among the words to
 * look for in the title, vendor, type or tags, a filter the search doesn't know, or a status it
 * doesn't have, refused.
 */
export function parseProductSearch(query: string): SearchParse<ProductSearchKey> {
  return parseSearch(query, PRODUCT_SEARCH);
}

/** What a search's filter matches, as an SQL condition on products `p`. */
function searchFilterCondition({ key, value }: SearchFilter<ProductSearchKey>): SQL {
  switch (key) {
    case 'status':
      return sql`p.status = ${value}`;
    case 'vendor':
      return sql`lower(p.vendor) = lower(${value})`;
    case 'product_type':
      return sql`lower(p.product_type) = lower(${value})`;
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM unnest(p.tags) AS t(tag) WHERE lower(t.tag) = lower(${value}))`;
    case 'handle':
      // Handles are lowercase.
      return sql`p.handle = lower(${value})`;
    case 'sku':
    case 'barcode':
      // Any of its variants'.
      return sql`EXISTS (SELECT 1 FROM catalog.variants v
                          WHERE v.shop_id = p.shop_id AND v.product_id = p.id
                            AND lower(${sql.identifier('v')}.${sql.identifier(key)}) = lower(${value}))`;
  }
}

/**
 * The search as SQL conditions on products `p`, all of which must hold. Its query must be one
 * that {@link parseProductSearch} takes: callers check it first, to say what is wrong.
 */
export function productSearchConditions(query: string): SQL[] {
  const search = parseProductSearch(query);
  if (!search.ok) throw new RangeError(search.error);
  const conditions: SQL[] = [];
  for (const filter of search.value.filters) {
    const condition = searchFilterCondition(filter);
    conditions.push(filter.negated ? sql`NOT coalesce((${condition}), false)` : condition);
  }
  // Every word must appear. Tokens hold only letters and digits, so no LIKE escaping.
  for (const token of searchKey(search.value.terms).split(' ').filter(Boolean)) {
    conditions.push(sql`p.search_text LIKE ${`%${token}%`}`);
  }
  return conditions;
}

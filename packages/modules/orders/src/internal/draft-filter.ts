import { parseSearch, type SearchFilter, type SearchParse, type SearchSyntax } from '@hatti/api';
import { parsePkMobile, searchKey } from '@hatti/pk';
import { sql, type SQL } from 'drizzle-orm';
import {
  DRAFT_ORDER_SOURCES,
  DRAFT_ORDER_STATUSES,
  PAYMENT_METHODS,
  draftOrders,
  type StoredAddressValue,
} from './schema.js';
import { searchTextOf } from './order-store.js';

/**
 * The filters a drafts search may name, as Shopify's search syntax writes them (`key:value`), with
 * the values each takes; a tag takes any, in any letter case (ADR-123).
 */
export const DRAFT_SEARCH_FILTERS = {
  status: DRAFT_ORDER_STATUSES,
  source: DRAFT_ORDER_SOURCES,
  payment_method: PAYMENT_METHODS,
  tag: null,
} as const satisfies Record<string, readonly string[] | null>;

export type DraftSearchKey = keyof typeof DRAFT_SEARCH_FILTERS;

const DRAFT_SEARCH: SearchSyntax<DraftSearchKey> = {
  noun: 'Drafts',
  filters: DRAFT_SEARCH_FILTERS,
  examples: { tag: 'vip' },
};

/**
 * A drafts search as Shopify's search syntax writes it (ADR-123): filters among the words, a
 * filter the search doesn't know, or a value its filter doesn't take, refused.
 */
export function parseDraftSearch(query: string): SearchParse<DraftSearchKey> {
  return parseSearch(query, DRAFT_SEARCH);
}

/** The words a draft is found by: its customer's name, city and email, folded. */
export function draftSearchText(address: StoredAddressValue | null, email: string | null): string {
  return address ? searchTextOf(address, email) : searchKey(email ?? '');
}

/** What a search's filter matches, as a condition on drafts. */
function searchFilterCondition({ key, value }: SearchFilter<DraftSearchKey>): SQL {
  switch (key) {
    case 'status':
      return sql`${draftOrders.status} = ${value}`;
    case 'source':
      return sql`${draftOrders.source} = ${value}`;
    case 'payment_method':
      return sql`${draftOrders.paymentMethod} = ${value}`;
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM unnest(${draftOrders.tags}) AS t(tag)
                          WHERE lower(t.tag) = lower(${value}))`;
  }
}

/**
 * The search as conditions on drafts, all of which must hold: a draft's number ("#D12", "D12" or
 * "12"), its customer's mobile in any format, or words of their name, city or email. Its query
 * must be one that {@link parseDraftSearch} takes: callers check it first, to say what is wrong.
 */
export function draftSearchConditions(query: string): SQL[] {
  const search = parseDraftSearch(query);
  if (!search.ok) throw new RangeError(search.error);
  const conditions: SQL[] = [];
  for (const filter of search.value.filters) {
    const condition = searchFilterCondition(filter);
    conditions.push(filter.negated ? sql`NOT coalesce((${condition}), false)` : condition);
  }
  const terms = search.value.terms;
  if (terms !== '') {
    const mobile = parsePkMobile(terms);
    const number = /^#?d?(\d{1,9})$/i.exec(terms);
    // Every word must appear. Tokens hold only letters and digits, so no LIKE escaping.
    const words = searchKey(terms)
      .split(' ')
      .filter(Boolean)
      .map((token) => sql`${draftOrders.searchText} LIKE ${`%${token}%`}`);
    conditions.push(
      mobile
        ? sql`${draftOrders.phone} = ${mobile.e164}`
        : number
          ? sql`${draftOrders.number} = ${Number(number[1])}`
          : words.length > 0
            ? sql`(${sql.join(words, sql` AND `)})`
            : sql`false`,
    );
  }
  return conditions;
}

import { parseSearch, type SearchFilter, type SearchParse, type SearchSyntax } from '@hatti/api';
import { normalizeDigits, parsePkMobile, searchKey } from '@hatti/pk';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { MARKETING_STATES, customerPhones, customers } from './schema.js';

/**
 * The filters a customers search may name, as Shopify's search syntax writes them (`key:value`):
 * a tag in any letter case, and each channel's marketing consent (ADR-126).
 */
export const CUSTOMER_SEARCH_FILTERS = {
  tag: null,
  whatsapp_marketing_state: MARKETING_STATES,
  sms_marketing_state: MARKETING_STATES,
  email_marketing_state: MARKETING_STATES,
} as const satisfies Record<string, readonly string[] | null>;

export type CustomerSearchKey = keyof typeof CUSTOMER_SEARCH_FILTERS;

const CUSTOMER_SEARCH: SearchSyntax<CustomerSearchKey> = {
  noun: 'Customers',
  filters: CUSTOMER_SEARCH_FILTERS,
  examples: { tag: 'vip' },
};

/**
 * A customers search as Shopify's search syntax writes it (ADR-126): filters among a number or
 * words, a filter the search doesn't know, or a value its filter doesn't take, refused.
 */
export function parseCustomerSearch(query: string): SearchParse<CustomerSearchKey> {
  return parseSearch(query, CUSTOMER_SEARCH);
}

/** What a search's filter matches, as a condition on customers. */
function searchFilterCondition({ key, value }: SearchFilter<CustomerSearchKey>): SQL {
  switch (key) {
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM unnest(${customers.tags}) AS t(tag)
                          WHERE lower(t.tag) = lower(${value}))`;
    case 'whatsapp_marketing_state':
      return sql`${customers.whatsappConsent} = ${value}`;
    case 'sms_marketing_state':
      return sql`${customers.smsConsent} = ${value}`;
    case 'email_marketing_state':
      return sql`${customers.emailConsent} = ${value}`;
  }
}

/**
 * The search as conditions on customers, all of which must hold: its filters, and the number or
 * words left as {@link customerMatch} matches them. Its query must be one that
 * {@link parseCustomerSearch} takes: callers check it first, to say what is wrong.
 */
export function customerSearchConditions(query: string, options: { partial: boolean }): SQL[] {
  const search = parseCustomerSearch(query);
  if (!search.ok) throw new RangeError(search.error);
  const conditions = search.value.filters.map((filter) => {
    const condition = searchFilterCondition(filter);
    return filter.negated ? sql`NOT coalesce((${condition}), false)` : condition;
  });
  if (search.value.terms !== '') conditions.push(customerMatch(search.value.terms, options));
  return conditions;
}

/**
 * How a search matches mobile numbers: a whole number in any format matches exactly, and four or
 * more digits match anywhere in it, so staff can find someone by the end of their number. Null
 * when the query is not a number. Staff who see numbers masked search by whole numbers only
 * (`partial: false`): matching digits anywhere would let them rebuild a number digit by digit.
 */
export function phoneMatch(
  column: AnyColumn,
  query: string,
  options: { partial: boolean },
): SQL | null {
  const mobile = parsePkMobile(query);
  if (mobile) return sql`${column} = ${mobile.e164}`;
  const digits = normalizeDigits(query).replace(/[\s\-().+]/g, '');
  if (!/^\d{4,}$/.test(digits)) return null;
  if (!options.partial) return sql`false`;
  // Stored numbers are E.164, "+923001234567": drop a leading 0 of the national form.
  return sql`${column} LIKE ${`%${digits.replace(/^0/, '')}%`}`;
}

/**
 * A customer search: one of their numbers, main or other, or words that must all appear in the
 * name or email.
 */
export function customerMatch(query: string, options: { partial: boolean }): SQL {
  const byPhone = phoneMatch(customerPhones.phone, query, options);
  if (byPhone) {
    return sql`EXISTS (SELECT 1 FROM ${customerPhones}
                        WHERE ${customerPhones.shopId} = ${customers.shopId}
                          AND ${customerPhones.customerId} = ${customers.id} AND ${byPhone})`;
  }
  // Tokens hold only letters and digits, so no LIKE escaping.
  const words = searchKey(query)
    .split(' ')
    .filter(Boolean)
    .map((token) => sql`${customers.searchText} LIKE ${`%${token}%`}`);
  return words.length > 0 ? sql`(${sql.join(words, sql` AND `)})` : sql`false`;
}

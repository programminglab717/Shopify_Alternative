import { parsePkMobile, searchKey } from '@hatti/pk';
import { sql, type SQL } from 'drizzle-orm';
import { trackingKey } from './cod-cash.js';
import {
  CONFIRMATION_STATUSES,
  FINANCIAL_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_SOURCES,
  ORDER_STAGES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  RISK_LEVELS,
  type OrderStageValue,
  type RiskLevelValue,
} from './schema.js';

/** Which orders a list or an export covers. Every part left out matches all. */
export interface OrderFilter {
  /**
   * An order number ("1001" or "#1001"), a mobile number in any format, a parcel's tracking
   * number, or words of the customer's name, city or email, with filters among them, as
   * {@link parseOrderSearch} reads them.
   */
  query?: string | null;
  stage?: OrderStageValue | null;
  riskLevel?: RiskLevelValue | null;
  /** One customer's orders only. */
  customerId?: string | null;
  /** Placed at or after. */
  placedFrom?: Date | null;
  /** Placed before. */
  placedBefore?: Date | null;
  /**
   * Orders whose customer sent a receipt for their transfer through their page (true), or that
   * have none (false) (ADR-080).
   */
  transferReceipt?: boolean | null;
}

/**
 * The filters an orders search may name, as Shopify's search syntax writes them (`key:value`),
 * with the values each takes; a tag takes any (ADR-118).
 */
export const ORDER_SEARCH_FILTERS = {
  stage: ORDER_STAGES,
  status: ORDER_STATUSES,
  confirmation_status: CONFIRMATION_STATUSES,
  financial_status: FINANCIAL_STATUSES,
  fulfillment_status: FULFILLMENT_STATUSES,
  payment_method: PAYMENT_METHODS,
  source: ORDER_SOURCES,
  risk_level: RISK_LEVELS,
  tag: null,
  has_transfer_receipt: ['true', 'false'],
} as const satisfies Record<string, readonly string[] | null>;

export type OrderSearchKey = keyof typeof ORDER_SEARCH_FILTERS;

/** A filter an orders search names. */
export interface OrderSearchFilter {
  key: OrderSearchKey;
  /** As the filter takes it: lowercase, but for a tag, as written. */
  value: string;
  /** Written with a leading minus: the orders it does not match. */
  negated: boolean;
}

/** An orders search, split into the filters it names and the words it looks for. */
export interface OrderSearch {
  filters: OrderSearchFilter[];
  /** The rest: an order number, a mobile number, a tracking number or words, one space apart. */
  terms: string;
}

/** `key:value` (`-key:value` to leave out, `key:"a value"`), a phrase in quotes, or a word. */
const SEARCH_TOKEN = /(-?)([A-Za-z_]+):(?:"([^"]*)"|([^\s"]*))|"([^"]*)"|(\S+)/g;

/**
 * An orders search as Shopify's search syntax writes it (ADR-118): filters, `key:value`, a value
 * in double quotes if it has spaces, a leading minus for the orders a filter does not match, among
 * the words to look for. A filter the search doesn't know, or a value its filter doesn't take, is
 * refused, naming what it takes.
 */
export function parseOrderSearch(
  query: string,
): { ok: true; value: OrderSearch } | { ok: false; error: string } {
  const filters: OrderSearchFilter[] = [];
  const terms: string[] = [];
  for (const match of query.matchAll(SEARCH_TOKEN)) {
    const [, minus, name, quoted, bare, phrase, word] = match;
    if (name === undefined) {
      terms.push((phrase ?? word)!);
      continue;
    }
    const key = name.toLowerCase();
    if (!Object.hasOwn(ORDER_SEARCH_FILTERS, key)) {
      return {
        ok: false,
        error: `Orders can't be filtered by ${key}; filters are ${Object.keys(ORDER_SEARCH_FILTERS).join(', ')}`,
      };
    }
    const values: readonly string[] | null = ORDER_SEARCH_FILTERS[key as OrderSearchKey];
    const written = (quoted ?? bare ?? '').trim();
    const value = values === null ? written : written.toLowerCase();
    if (value === '')
      return { ok: false, error: `Give ${key} a value, such as ${key}:${values?.[0] ?? 'vip'}` };
    if (values !== null && !values.includes(value)) {
      return { ok: false, error: `${key} is one of ${values.join(', ')}, not ${written}` };
    }
    filters.push({ key: key as OrderSearchKey, value, negated: minus === '-' });
  }
  return { ok: true, value: { filters, terms: terms.join(' ').trim() } };
}

/** What a search's filter matches, as an SQL condition on orders `o`. */
function searchFilterCondition({ key, value }: OrderSearchFilter): SQL {
  switch (key) {
    case 'tag':
      return sql`EXISTS (SELECT 1 FROM unnest(o.tags) AS t(tag) WHERE lower(t.tag) = lower(${value}))`;
    case 'has_transfer_receipt':
      return transferReceiptCondition(value === 'true');
    default:
      // The key is one of the module's, so a column of its own name.
      return sql`${sql.identifier('o')}.${sql.identifier(key)} = ${value}`;
  }
}

/** Orders whose customer sent a receipt for their transfer (`sent`), or that have none. */
function transferReceiptCondition(sent: boolean): SQL {
  const exists = sql`EXISTS (SELECT 1 FROM orders.transfer_receipts r
                              WHERE r.shop_id = o.shop_id AND r.order_id = o.id)`;
  return sent ? exists : sql`NOT ${exists}`;
}

/**
 * The filter as SQL conditions on orders `o`, all of which must hold. Its query must be one that
 * {@link parseOrderSearch} takes: callers check it first, to say what is wrong.
 */
export function orderConditions(filter: OrderFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.stage) conditions.push(sql`o.stage = ${filter.stage}`);
  if (filter.riskLevel) conditions.push(sql`o.risk_level = ${filter.riskLevel}`);
  if (filter.customerId) conditions.push(sql`o.customer_id = ${filter.customerId}`);
  if (filter.placedFrom) conditions.push(sql`o.created_at >= ${filter.placedFrom}`);
  if (filter.placedBefore) conditions.push(sql`o.created_at < ${filter.placedBefore}`);
  if (filter.transferReceipt !== undefined && filter.transferReceipt !== null) {
    conditions.push(transferReceiptCondition(filter.transferReceipt));
  }
  const search = parseOrderSearch(filter.query ?? '');
  if (!search.ok) throw new RangeError(search.error);
  for (const searchFilter of search.value.filters) {
    const condition = searchFilterCondition(searchFilter);
    conditions.push(searchFilter.negated ? sql`NOT coalesce((${condition}), false)` : condition);
  }
  const query = search.value.terms;
  if (query !== '') {
    const mobile = parsePkMobile(query);
    // Every word must appear. Tokens hold only letters and digits, so no LIKE escaping.
    const words = searchKey(query)
      .split(' ')
      .filter(Boolean)
      .map((token) => sql`o.search_text LIKE ${`%${token}%`}`);
    const match = mobile
      ? sql`o.phone = ${mobile.e164}`
      : /^#?\d{1,9}$/.test(query)
        ? sql`o.number = ${Number(query.replace('#', ''))}`
        : words.length > 0
          ? sql.join(words, sql` AND `)
          : sql`false`;
    // A parcel's tracking number finds its order too, as a scanner or a person types it: spaces
    // and letter case ignored, as couriers' statements are matched.
    conditions.push(sql`(${match} OR EXISTS (
      SELECT 1 FROM orders.fulfillments f
       WHERE f.shop_id = o.shop_id AND f.order_id = o.id
         AND upper(regexp_replace(f.tracking_number, '\\s', '', 'g')) = ${trackingKey(query)}))`);
  }
  return conditions;
}

import { parseSearch, type SearchFilter, type SearchParse, type SearchSyntax } from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
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
  /**
   * Whom `assignee:me` names: the member of staff searching, by their account's ID; an app
   * searching is no one, so it matches nothing (ADR-127).
   */
  me?: string | null;
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
  /** `me`, `none`, or a member of staff by their account's ID, `usr_…` (ADR-127). */
  assignee: null,
} as const satisfies Record<string, readonly string[] | null>;

export type OrderSearchKey = keyof typeof ORDER_SEARCH_FILTERS;

/** A filter an orders search names. */
export type OrderSearchFilter = SearchFilter<OrderSearchKey>;

const ORDER_SEARCH: SearchSyntax<OrderSearchKey> = {
  noun: 'Orders',
  filters: ORDER_SEARCH_FILTERS,
  examples: { tag: 'vip' },
};

/**
 * An orders search as Shopify's search syntax writes it (ADR-118): filters among the words to
 * look for, a filter the search doesn't know, or a value its filter doesn't take, refused.
 */
export function parseOrderSearch(query: string): SearchParse<OrderSearchKey> {
  const search = parseSearch(query, ORDER_SEARCH);
  if (!search.ok) return search;
  for (const filter of search.value.filters) {
    if (filter.key === 'assignee' && assigneeOf(filter.value) === undefined) {
      return {
        ok: false,
        error: `assignee is me, none or a member of staff's ID (usr_…), not ${filter.value}`,
      };
    }
  }
  return search;
}

/** Whom an assignee filter names: the caller, no one (null), or a member of staff by UUID. */
function assigneeOf(value: string): 'me' | null | string | undefined {
  const lower = value.toLowerCase();
  if (lower === 'me') return 'me';
  if (lower === 'none') return null;
  return tryFromPublicId(value, 'user') ?? undefined;
}

/** What a search's filter matches, as an SQL condition on orders `o`. */
function searchFilterCondition({ key, value }: OrderSearchFilter, me: string | null): SQL {
  switch (key) {
    case 'assignee': {
      const assignee = assigneeOf(value);
      if (assignee === null) return sql`o.assignee_id IS NULL`;
      const id = assignee === 'me' ? me : assignee;
      return id ? sql`o.assignee_id = ${id}` : sql`false`;
    }
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
    const condition = searchFilterCondition(searchFilter, filter.me ?? null);
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

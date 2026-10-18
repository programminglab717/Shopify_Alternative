import { toDate, toDateOrNull, type Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { messageLinkIn } from './customer-answers.js';
import { orderLinkExpiry } from './rules.js';
import type {
  FinancialStatusValue,
  FulfillmentStatusValue,
  OrderStageValue,
  OrderStatusValue,
} from './schema.js';

// A customer's orders as their account on the shop's storefront shows them (CUS-02, ADR-570):
// those placed with the shop that are theirs now, numbers merged into them too, as the shopper
// who signed in with one of their numbers sees them; and each one's page, its link (ADR-050), as
// the account opens it.

/** An order as the customer's account lists it. */
export interface AccountOrderFacts {
  id: string;
  /** #1001 onwards. */
  number: number;
  status: OrderStatusValue;
  financialStatus: FinancialStatusValue;
  fulfillmentStatus: FulfillmentStatusValue;
  /** The state staff see it in, which the shopper's words follow: "on its way". */
  stage: OrderStageValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  /** The units it has of everything. */
  itemCount: number;
  placedAt: Date;
  /**
   * Whether its page can be opened from the account: while it is open, and for 30 days once it
   * closed, as its link works (ADR-400); never once it was cancelled.
   */
  hasPage: boolean;
}

/**
 * The customer `customerId`'s latest `limit` orders with the shop, the newest first, in the
 * caller's transaction. An erased customer has none: their orders name a customer the shop no
 * longer has.
 */
export async function accountOrdersIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  limit: number,
  at: Date = new Date(),
): Promise<AccountOrderFacts[]> {
  return ordersOf(tx, shopId, customerId, { limit }, at);
}

/**
 * The page of the customer `customerId`'s order `orderId`, as their account opens it: the path
 * of its link on the public site, "/o/…". The link its messages carry, one of `known`, while it is
 * still the order's and works (ADR-160); a new one otherwise, which replaces the order's previous
 * link, as a message's does. Null for an order that is not theirs, or has no page: cancelled,
 * closed more than 30 days ago, or its customer erased.
 */
export async function accountOrderLinkIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  orderId: string,
  known: readonly string[] = [],
  at: Date = new Date(),
): Promise<string | null> {
  const [order] = await ordersOf(tx, shopId, customerId, { limit: 1, orderId }, at);
  if (!order?.hasPage) return null;
  return messageLinkIn(tx, shopId, orderId, 'to open from their account on the storefront', known, {
    ended: true,
  });
}

async function ordersOf(
  tx: Tx,
  shopId: string,
  customerId: string,
  options: { limit: number; orderId?: string },
  at: Date,
): Promise<AccountOrderFacts[]> {
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    status: OrderStatusValue;
    financial_status: FinancialStatusValue;
    fulfillment_status: FulfillmentStatusValue;
    stage: OrderStageValue;
    currency: string;
    total: string;
    item_count: number;
    created_at: string | Date;
    closed_at: string | Date | null;
    cancelled_at: string | Date | null;
  }>(sql`
    SELECT o.id, o.number, o.status, o.financial_status, o.fulfillment_status, o.stage,
           o.currency, o.total::text AS total, o.created_at, o.closed_at, o.cancelled_at,
           coalesce((SELECT sum(l.quantity) FROM orders.lines l
                      WHERE l.shop_id = o.shop_id AND l.order_id = o.id), 0)::int AS item_count
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.customer_id = ${customerId}
       AND o.customer_erased_at IS NULL
       ${options.orderId ? sql`AND o.id = ${options.orderId}` : sql``}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${options.limit}`);
  return rows.map((row) => {
    const ends = orderLinkExpiry({
      status: row.status,
      linkExpiresAt: null,
      closedAt: toDateOrNull(row.closed_at),
      cancelledAt: toDateOrNull(row.cancelled_at),
    });
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      financialStatus: row.financial_status,
      fulfillmentStatus: row.fulfillment_status,
      stage: row.stage,
      currency: row.currency,
      total: BigInt(row.total),
      itemCount: row.item_count,
      placedAt: toDate(row.created_at),
      hasPage: row.status !== 'cancelled' && (ends === null || ends > at),
    };
  });
}

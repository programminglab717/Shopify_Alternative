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
// the account opens it. Each has what it sold, for the shopper to buy again (ADR-574): its lines
// as they were sold, a bundle's parts as the bundle (ADR-410), which the catalog and the cart
// say can be had again or not.

/** What an order sold, as its customer's account offers it again (ADR-574). */
export type AccountOrderItemFacts =
  | {
      kind: 'line';
      variantId: string;
      productId: string;
      /** The product's and the variant's, as it was sold. */
      title: string;
      variantTitle: string;
      /** Its lines' of the variant together. */
      quantity: number;
    }
  | {
      kind: 'bundle';
      /** Its own product's title, as it was sold. */
      title: string;
      /** How many of it were ordered. */
      quantity: number;
      /** The variants it was sold as, and how many units of each, for all `quantity` of it. */
      parts: { variantId: string; productId: string; units: number }[];
    };

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

/** An order as the customer's account lists it, with what it sold. */
export interface AccountOrderWithItems extends AccountOrderFacts {
  /** In the order its lines have, each where its first line is. */
  items: AccountOrderItemFacts[];
}

/**
 * The customer `customerId`'s latest `limit.orders` orders with the shop, the newest first, in
 * the caller's transaction, with what each sold, of its first `limit.lines` lines: a bundle cut
 * short by them is one the catalog finds no longer. An erased customer has none: their orders
 * name a customer the shop no longer has.
 */
export async function accountOrdersIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  limit: { orders: number; lines: number },
  at: Date = new Date(),
): Promise<AccountOrderWithItems[]> {
  const orders = await ordersOf(tx, shopId, customerId, { limit: limit.orders }, at);
  const items = await itemsOf(
    tx,
    shopId,
    orders.map((order) => order.id),
    limit.lines,
  );
  return orders.map((order) => ({ ...order, items: items.get(order.id) ?? [] }));
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

/**
 * What the orders `orderIds` sold, by order, of the first `lines` lines of each: lines of a
 * variant together, as the cart has them, and each bundle once, its parts' lines together (a
 * multipack's split by price among them).
 */
async function itemsOf(
  tx: Tx,
  shopId: string,
  orderIds: readonly string[],
  lines: number,
): Promise<Map<string, AccountOrderItemFacts[]>> {
  if (orderIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    order_id: string;
    variant_id: string;
    product_id: string;
    title: string;
    variant_title: string;
    quantity: number;
    bundle_key: string | null;
    bundle_title: string | null;
    bundle_quantity: number | null;
  }>(sql`
    SELECT o.id AS order_id, l.variant_id, l.product_id, l.title, l.variant_title, l.quantity,
           l.bundle_key, l.bundle_title, l.bundle_quantity
      FROM unnest(${sql.param([...orderIds])}::uuid[]) AS o(id)
      CROSS JOIN LATERAL (
        SELECT variant_id, product_id, title, variant_title, quantity,
               bundle_key, bundle_title, bundle_quantity, position
          FROM orders.lines
         WHERE shop_id = ${shopId} AND order_id = o.id
         ORDER BY position
         LIMIT ${lines}) l
     ORDER BY o.id, l.position`);
  const items = new Map<string, AccountOrderItemFacts[]>();
  const bundles = new Map<string, Extract<AccountOrderItemFacts, { kind: 'bundle' }>>();
  for (const row of rows) {
    let listed = items.get(row.order_id);
    if (!listed) {
      listed = [];
      items.set(row.order_id, listed);
    }
    if (row.bundle_key === null) {
      const same = listed.find((item) => item.kind === 'line' && item.variantId === row.variant_id);
      if (same) same.quantity += row.quantity;
      else {
        listed.push({
          kind: 'line',
          variantId: row.variant_id,
          productId: row.product_id,
          title: row.title,
          variantTitle: row.variant_title,
          quantity: row.quantity,
        });
      }
      continue;
    }
    // Its key is the order's own: a new one each time a bundle is sold.
    let bundle = bundles.get(row.bundle_key);
    if (!bundle) {
      bundle = {
        kind: 'bundle',
        title: row.bundle_title!,
        quantity: row.bundle_quantity!,
        parts: [],
      };
      bundles.set(row.bundle_key, bundle);
      listed.push(bundle);
    }
    const part = bundle.parts.find((each) => each.variantId === row.variant_id);
    if (part) part.units += row.quantity;
    else {
      bundle.parts.push({
        variantId: row.variant_id,
        productId: row.product_id,
        units: row.quantity,
      });
    }
  }
  return items;
}

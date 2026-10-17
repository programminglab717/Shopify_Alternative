import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

// Frequently bought together (SRC-05, ADR-480): the other products in the orders a product was
// in. Orders cancelled don't count, nor those older than a year; a pair is bought together once
// two orders have both. The most recent orders of each product alone are read, so a shop's
// best seller costs no more than the rest.

/** The most products bought with one that are given for it. */
export const BOUGHT_TOGETHER = 10;
/** How many orders must have both before they are bought together. */
export const BOUGHT_TOGETHER_ORDERS = 2;
/** How many of a product's latest orders are read for it. */
const ORDERS_READ = 500;
/** How far back orders are read. */
const DAYS_READ = 365;

/**
 * The products bought with each of `productIds`, those in the most orders with it first, then
 * those bought with it latest. Products bought with none are left out.
 */
export async function boughtTogetherIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ product_id: string; together: string[] }>(sql`
    SELECT me.product_id,
           ARRAY(
             SELECT other.product_id
               FROM (SELECT o.id, o.created_at
                       FROM orders.lines mine
                       JOIN orders.orders o
                         ON o.shop_id = mine.shop_id AND o.id = mine.order_id
                        AND o.status <> 'cancelled'
                        AND o.created_at > now() - make_interval(days => ${DAYS_READ})
                      WHERE mine.shop_id = ${shopId} AND mine.product_id = me.product_id
                      GROUP BY o.id, o.created_at
                      ORDER BY o.created_at DESC
                      LIMIT ${ORDERS_READ}) bought
               JOIN orders.lines other
                 ON other.shop_id = ${shopId} AND other.order_id = bought.id
                AND other.product_id <> me.product_id
              GROUP BY other.product_id
             HAVING count(DISTINCT bought.id) >= ${BOUGHT_TOGETHER_ORDERS}
              ORDER BY count(DISTINCT bought.id) DESC, max(bought.created_at) DESC,
                       other.product_id
              LIMIT ${BOUGHT_TOGETHER}
           ) AS together
      FROM unnest(${sql.param([...productIds])}::uuid[]) AS me(product_id)`);
  return new Map(
    rows.filter((row) => row.together.length > 0).map((row) => [row.product_id, row.together]),
  );
}

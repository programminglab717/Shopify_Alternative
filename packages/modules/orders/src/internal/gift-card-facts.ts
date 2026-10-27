import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { OrderStatusValue } from './schema.js';

/** An order as the worker reads it to issue the gift cards it sold (CAT-12, ADR-451). */
export interface OrderGiftCardFacts {
  id: string;
  number: number;
  status: OrderStatusValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  amountPaid: bigint;
  customerId: string;
  /** Its customer's number; null once they were erased. */
  phone: string | null;
  /** Its lines, in their order: what each unit sold for, before the order's discount. */
  lines: { id: string; productId: string; quantity: number; unitPrice: bigint }[];
}

/** The order `orderId` as the gift cards it sold are issued from; null if gone. */
export async function orderGiftCardFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderGiftCardFacts | null> {
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    status: OrderStatusValue;
    currency: string;
    total: string;
    amount_paid: string;
    customer_id: string;
    phone: string | null;
    lines: { id: string; productId: string; quantity: number; unitPrice: string }[];
  }>(sql`
    SELECT o.id, o.number, o.status, o.currency, o.total, o.amount_paid, o.customer_id,
           CASE WHEN o.customer_erased_at IS NULL THEN o.phone END AS phone,
           coalesce((SELECT jsonb_agg(jsonb_build_object('id', l.id,
                                                         'productId', l.product_id,
                                                         'quantity', l.quantity,
                                                         'unitPrice', l.unit_price::text)
                                      ORDER BY l.position)
                       FROM orders.lines l
                      WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    total: BigInt(row.total),
    amountPaid: BigInt(row.amount_paid),
    customerId: row.customer_id,
    phone: row.phone,
    lines: row.lines.map((line) => ({ ...line, unitPrice: BigInt(line.unitPrice) })),
  };
}

/**
 * The orders paid in full and not cancelled with a line of product `productId`, the oldest first,
 * with those lines: for the units still owed a digital product's keys (ADR-816).
 */
export async function paidOrdersWithProductIn(
  tx: Tx,
  shopId: string,
  productId: string,
  limit = 200,
): Promise<{ orderId: string; lines: { id: string; quantity: number }[] }[]> {
  const { rows } = await tx.execute<{ order_id: string; line_id: string; quantity: number }>(sql`
    SELECT o.id AS order_id, l.id AS line_id, l.quantity
      FROM orders.orders o
      JOIN orders.lines l ON l.shop_id = o.shop_id AND l.order_id = o.id
     WHERE o.shop_id = ${shopId} AND l.product_id = ${productId}
       AND o.status <> 'cancelled' AND o.amount_paid >= o.total
     ORDER BY o.created_at, o.id
     LIMIT ${limit}`);
  const orders = new Map<string, { id: string; quantity: number }[]>();
  for (const row of rows) {
    orders.set(row.order_id, [
      ...(orders.get(row.order_id) ?? []),
      { id: row.line_id, quantity: row.quantity },
    ]);
  }
  return [...orders].map(([orderId, lines]) => ({ orderId, lines }));
}

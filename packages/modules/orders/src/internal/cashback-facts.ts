import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { OrderStageValue, OrderStatusValue } from './schema.js';

/** An order as the worker reads it to give its customer cashback (PAY-13, ADR-453). */
export interface OrderCashbackFacts {
  id: string;
  number: number;
  status: OrderStatusValue;
  stage: OrderStageValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  amountPaid: bigint;
  /** What its goods came to after its discount: what cashback is a share of. */
  goods: bigint;
  /** What its lines came to, before its discount. */
  subtotal: bigint;
  /** What was refunded of it. */
  amountRefunded: bigint;
  /** Each line's product and what it came to, for those that earn none, as gift cards (ADR-805). */
  lines: { productId: string; total: bigint }[];
  customerId: string;
  /** Whether its customer was erased since. */
  erased: boolean;
}

/** The order `orderId` as cashback reads it; null if gone. */
export async function orderCashbackFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderCashbackFacts | null> {
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    status: OrderStatusValue;
    stage: OrderStageValue;
    currency: string;
    total: string;
    amount_paid: string;
    goods: string;
    subtotal: string;
    amount_refunded: string;
    customer_id: string;
    erased: boolean;
    lines: { product_id: string; total: string }[];
  }>(sql`
    SELECT o.id, o.number, o.status, o.stage, o.currency, o.total::text, o.amount_paid::text,
           greatest(o.subtotal - o.discount, 0)::text AS goods, o.subtotal::text,
           o.amount_refunded::text, o.customer_id,
           o.customer_erased_at IS NOT NULL AS erased,
           coalesce((SELECT json_agg(json_build_object('product_id', l.product_id,
                                                       'total', l.total::text))
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
    stage: row.stage,
    currency: row.currency,
    total: BigInt(row.total),
    amountPaid: BigInt(row.amount_paid),
    goods: BigInt(row.goods),
    subtotal: BigInt(row.subtotal),
    amountRefunded: BigInt(row.amount_refunded),
    lines: row.lines.map((line) => ({ productId: line.product_id, total: BigInt(line.total) })),
    customerId: row.customer_id,
    erased: row.erased,
  };
}

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
    customer_id: string;
    erased: boolean;
  }>(sql`
    SELECT id, number, status, stage, currency, total::text, amount_paid::text,
           greatest(subtotal - discount, 0)::text AS goods, customer_id,
           customer_erased_at IS NOT NULL AS erased
      FROM orders.orders
     WHERE shop_id = ${shopId} AND id = ${orderId}`);
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
    customerId: row.customer_id,
    erased: row.erased,
  };
}

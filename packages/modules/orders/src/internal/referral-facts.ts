import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { AttributionValue } from './attribution.js';
import type { OrderStageValue, OrderStatusValue } from './schema.js';

/** Where an order went, and from what, as the checks of referrals compare them (ADR-807). */
export interface OrderTrace {
  /** The address its customer ordered from, and their browser; null where none was kept. */
  clientIp: string | null;
  userAgent: string | null;
  /** Its shipping address's house and street, and its city. */
  address1: string;
  city: string;
}

/** An order as the worker reads it to reward a referral (MKT-07, ADR-807). */
export interface OrderReferralFacts extends OrderTrace {
  id: string;
  number: number;
  status: OrderStatusValue;
  stage: OrderStageValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  amountPaid: bigint;
  /** What its goods came to after its discount. */
  goods: bigint;
  customerId: string;
  /** Whether its customer was erased since. */
  erased: boolean;
  /** The code of the link that brought it: `ref` of its last visit's landing page, or its first. */
  referralCode: string | null;
  /** How many orders its customer placed before it, not cancelled. */
  otherOrders: number;
}

/** A customer's orders as referrals compare them (ADR-807): and whether any was delivered. */
export interface CustomerOrderTraces {
  traces: OrderTrace[];
  /** Whether one of their orders reached them, paid in full. */
  received: boolean;
}

/** The code in a landing page's `ref`, in capitals; null where it has none. */
export function referralCodeOf(attribution: AttributionValue | null): string | null {
  for (const visit of attribution ? [attribution.last, attribution.first] : []) {
    if (!visit.landingPage) continue;
    try {
      const code = new URL(visit.landingPage).searchParams.get('ref')?.trim().toUpperCase();
      if (code && /^[A-Z0-9]{4,16}$/.test(code)) return code;
    } catch {
      // Not an address: no code.
    }
  }
  return null;
}

type TraceRow = {
  client_ip: string | null;
  user_agent: string | null;
  address1: string | null;
  city: string | null;
};

const traceOf = (row: TraceRow): OrderTrace => ({
  clientIp: row.client_ip,
  userAgent: row.user_agent,
  address1: row.address1 ?? '',
  city: row.city ?? '',
});

/** Order `orderId` as the worker reads it to reward a referral; null where there is none. */
export async function orderReferralFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderReferralFacts | null> {
  const { rows } = await tx.execute<
    TraceRow & {
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
      attribution: AttributionValue | null;
      other_orders: number;
    }
  >(sql`
    SELECT o.id, o.number, o.status, o.stage, o.currency, o.total::text,
           o.amount_paid::text, greatest(o.subtotal - o.discount, 0)::text AS goods,
           o.customer_id, o.customer_erased_at IS NOT NULL AS erased, o.attribution,
           host(o.client_ip) AS client_ip, o.client_user_agent AS user_agent,
           o.shipping_address ->> 'address1' AS address1, o.shipping_address ->> 'city' AS city,
           (SELECT count(*)::int FROM orders.orders p
             WHERE p.shop_id = o.shop_id AND p.customer_id = o.customer_id AND p.id <> o.id
               AND p.created_at < o.created_at
               AND p.status <> 'cancelled' AND p.merged_into_id IS NULL
               AND p.split_from_id IS DISTINCT FROM o.id
               AND o.split_from_id IS DISTINCT FROM p.id) AS other_orders
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
    customerId: row.customer_id,
    erased: row.erased,
    referralCode: referralCodeOf(row.attribution),
    otherOrders: row.other_orders,
    ...traceOf(row),
  };
}

/** Customer `customerId`'s orders as referrals compare them. */
export async function customerOrderTracesIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<CustomerOrderTraces> {
  const { rows } = await tx.execute<TraceRow & { received: boolean }>(sql`
    SELECT host(client_ip) AS client_ip, client_user_agent AS user_agent,
           shipping_address ->> 'address1' AS address1, shipping_address ->> 'city' AS city,
           (stage IN ('delivered', 'completed') AND status <> 'cancelled'
            AND amount_paid >= total) AS received
      FROM orders.orders
     WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND merged_into_id IS NULL`);
  return { traces: rows.map(traceOf), received: rows.some((row) => row.received) };
}

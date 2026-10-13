import { REVIEW_LIMITS, ordersReviewedIn, shopsRequestingReviewsIn } from '@hatti/catalog/public';
import { toDate, type Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { addTimelineEntry } from './order-store.js';
import { orderName } from './rules.js';

/** How long after the day a shop asks for reviews an order is still asked about, in days. */
export const REVIEW_REQUEST_LIMITS = { withinDays: 3, perSweep: 200 } as const;

/** A delivered order whose customer the shop asks to rate what it brought (ADR-400). */
export interface ReviewRequestDue {
  orderId: string;
  /** "#1006". */
  name: string;
  phone: string;
  customerId: string;
  /** The name on its address, if any. */
  customerName: string | null;
  deliveredAt: Date;
}

/**
 * The shop's orders to ask about now (MKT-05, ADR-400), locked for the caller's transaction:
 * delivered, their last parcel `afterDays` days ago or more, but not `withinDays` days more, their
 * customer neither asked yet nor erased, and nothing of the order rated yet: one rated already is
 * marked settled instead. The oldest first.
 */
export async function reviewRequestsDueIn(
  tx: Tx,
  shopId: string,
  at: Date,
  afterDays: number,
): Promise<ReviewRequestDue[]> {
  const before = new Date(at.getTime() - afterDays * 86_400_000);
  const since = new Date(before.getTime() - REVIEW_REQUEST_LIMITS.withinDays * 86_400_000);
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    phone: string;
    customer_id: string;
    name: string | null;
    delivered_at: string | Date;
  }>(sql`
    WITH delivered AS (
      SELECT f.order_id, max(f.delivered_at) AS delivered_at
        FROM orders.fulfillments f
       WHERE f.shop_id = ${shopId}
         AND f.delivered_at > ${since.toISOString()}::timestamptz
       GROUP BY f.order_id)
    SELECT o.id, o.number, o.phone, o.customer_id, o.shipping_address ->> 'name' AS name,
           d.delivered_at
      FROM delivered d
      JOIN orders.orders o ON o.shop_id = ${shopId} AND o.id = d.order_id
     WHERE d.delivered_at <= ${before.toISOString()}::timestamptz
       AND o.stage IN ('delivered', 'completed') AND o.review_requested_at IS NULL
       AND o.phone IS NOT NULL AND o.customer_erased_at IS NULL
     ORDER BY d.delivered_at, o.id
     LIMIT ${REVIEW_REQUEST_LIMITS.perSweep}
       FOR UPDATE OF o SKIP LOCKED`);
  // Those rated before they were asked about are settled, so that no sweep picks them again.
  const reviewed = await ordersReviewedIn(
    tx,
    shopId,
    rows.map((row) => row.id),
  );
  if (reviewed.size > 0) {
    await tx.execute(sql`
      UPDATE orders.orders SET review_requested_at = ${at.toISOString()}::timestamptz
       WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...reviewed])}::uuid[])`);
  }
  return rows
    .filter((row) => !reviewed.has(row.id))
    .map((row) => ({
      orderId: row.id,
      name: orderName(row.number),
      phone: row.phone,
      customerId: row.customer_id,
      customerName: row.name,
      deliveredAt: toDate(row.delivered_at),
    }));
}

/** The order's customer was asked for a review at `at`, once, as its timeline says. */
export async function markReviewRequestedIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE orders.orders SET review_requested_at = ${at.toISOString()}::timestamptz
     WHERE shop_id = ${shopId} AND id = ${orderId}`);
  await addTimelineEntry(
    tx,
    shopId,
    orderId,
    'system',
    'review_requested',
    'Asked the customer on WhatsApp to rate what it brought',
  );
}

/** The shops with orders delivered lately that ask for reviews: with the system role. */
export async function shopsAskingForReviewsIn(tx: Tx, at: Date): Promise<string[]> {
  const days = REVIEW_LIMITS.requestAfterDays + REVIEW_REQUEST_LIMITS.withinDays;
  const since = new Date(at.getTime() - days * 86_400_000);
  const asking = await shopsRequestingReviewsIn(tx);
  if (asking.length === 0) return [];
  const { rows } = await tx.execute<{ shop_id: string }>(sql`
    SELECT DISTINCT f.shop_id FROM orders.fulfillments f
     WHERE f.shop_id = ANY(${sql.param(asking)}::uuid[])
       AND f.delivered_at > ${since.toISOString()}::timestamptz`);
  return rows.map((row) => row.shop_id);
}

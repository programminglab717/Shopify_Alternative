import { REVIEW_LIMITS } from '@hatti/catalog/public';
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
 * customer neither asked yet nor erased, and nothing of the order rated yet. The oldest first.
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
       AND NOT EXISTS (SELECT 1 FROM catalog.product_reviews r
                        WHERE r.shop_id = ${shopId} AND r.order_id = o.id)
     ORDER BY d.delivered_at, o.id
     LIMIT ${REVIEW_REQUEST_LIMITS.perSweep}
       FOR UPDATE OF o SKIP LOCKED`);
  return rows.map((row) => ({
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
  const { rows } = await tx.execute<{ shop_id: string }>(sql`
    SELECT s.shop_id FROM catalog.review_settings s
     WHERE s.request_after_days IS NOT NULL
       AND EXISTS (SELECT 1 FROM orders.fulfillments f
                    WHERE f.shop_id = s.shop_id
                      AND f.delivered_at > ${since.toISOString()}::timestamptz)`);
  return rows.map((row) => row.shop_id);
}

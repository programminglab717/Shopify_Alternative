import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Failed-delivery rescue (COD-08, ADR-388): a parcel whose courier tried to deliver it and could
// not is one to save before the courier sends it back. Its customer is asked on WhatsApp whether
// to deliver it again or call them first; their answer is kept on the parcel, and the shop sees
// the parcels whose last step is a failed attempt, with what each customer said, to tell their
// couriers.

/** What a customer answers when asked about a delivery that failed. */
export const RESCUE_ANSWER_VALUES = ['retry', 'call'] as const;
export type RescueAnswerValue = (typeof RESCUE_ANSWER_VALUES)[number];

export const DELIVERY_RESCUE_LIMITS = {
  /** Parcels listed at most. */
  first: 100,
} as const;

/** A parcel whose last step is a failed delivery: one to rescue. */
export interface DeliveryToRescue {
  /** The parcel's ID. */
  id: string;
  orderId: string;
  orderNumber: number;
  /** As the order's address has them; null once the customer's data is erased. */
  customerName: string | null;
  city: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** When the courier last tried, and what it said: "Customer not available". */
  attemptedAt: Date;
  reason: string | null;
  /** How many times the courier has tried. */
  attempts: number;
  /** What the customer answered since that last try, and when; null while they have not. */
  answer: RescueAnswerValue | null;
  answeredAt: Date | null;
}

export interface DeliveriesToRescue {
  /** All of them, however many are listed. */
  count: number;
  /** Those the customer answered first, for the shop to tell their couriers; then the latest. */
  parcels: DeliveryToRescue[];
}

/** Parcels on their way whose last step is a failed delivery, with what it was. */
const LAST_TRIED = sql`
  SELECT DISTINCT ON (e.fulfillment_id)
         e.fulfillment_id, e.status, e.happened_at, e.message
    FROM orders.fulfillment_events e
    JOIN orders.fulfillments f ON f.shop_id = e.shop_id AND f.id = e.fulfillment_id
   WHERE f.status = 'in_transit' AND f.lost_at IS NULL`;

/**
 * Records `answer` on the order's parcels waiting after a failed delivery, in the caller's
 * transaction (ADR-388): when, as `at`, so an answer counts for the try it answers alone. The
 * parcels it was recorded on; none once they moved on, delivered or coming back.
 */
export async function recordRescueIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  answer: RescueAnswerValue,
  at: Date,
): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH last AS (
      ${LAST_TRIED} AND f.shop_id = ${shopId} AND f.order_id = ${orderId}
       ORDER BY e.fulfillment_id, e.happened_at DESC, e.id DESC
    )
    UPDATE orders.fulfillments f
       SET rescue_answer = ${answer}, rescue_answered_at = ${at.toISOString()}::timestamptz
      FROM last
     WHERE f.shop_id = ${shopId} AND f.id = last.fulfillment_id
       AND last.status = 'attempted_delivery'
    RETURNING f.id`);
  return rows.map((row) => row.id);
}

type Row = {
  id: string;
  order_id: string;
  number: number;
  name: string | null;
  city: string | null;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  attempted_at: string | Date;
  message: string | null;
  attempts: number;
  answer: RescueAnswerValue | null;
  answered_at: string | Date | null;
  total: number;
};

@Injectable()
export class DeliveryRescueService {
  constructor(private readonly db: Database) {}

  /**
   * The parcels to rescue (ADR-388): on their way, their last step a failed delivery. Those whose
   * customers answered since come first, the latest answer first; then the latest tries.
   */
  async list(tenant: TenantContext, first: number): Promise<DeliveriesToRescue> {
    const limit = Math.min(Math.max(first, 0), DELIVERY_RESCUE_LIMITS.first);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        WITH last AS (
          ${LAST_TRIED} AND f.shop_id = ${tenant.shopId}
           ORDER BY e.fulfillment_id, e.happened_at DESC, e.id DESC
        ), tried AS (
          SELECT f.id, f.order_id, o.number,
                 nullif(btrim(o.shipping_address->>'name'), '') AS name,
                 nullif(btrim(o.shipping_address->>'city'), '') AS city,
                 f.tracking_company, f.tracking_number, f.tracking_url,
                 last.happened_at AS attempted_at, last.message,
                 (SELECT count(*)::int FROM orders.fulfillment_events a
                   WHERE a.shop_id = f.shop_id AND a.fulfillment_id = f.id
                     AND a.status = 'attempted_delivery') AS attempts,
                 CASE WHEN f.rescue_answered_at >= last.happened_at THEN f.rescue_answer END
                   AS answer,
                 CASE WHEN f.rescue_answered_at >= last.happened_at THEN f.rescue_answered_at END
                   AS answered_at
            FROM last
            JOIN orders.fulfillments f ON f.shop_id = ${tenant.shopId} AND f.id = last.fulfillment_id
            JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
           WHERE last.status = 'attempted_delivery'
        )
        SELECT *, count(*) OVER ()::int AS total
          FROM tried
         ORDER BY answered_at DESC NULLS LAST, attempted_at DESC, id
         LIMIT ${limit}`);
      // Counted alone when none are listed.
      const count =
        rows[0]?.total ??
        (limit === 0
          ? ((
              await tx.execute<{ total: number }>(sql`
                WITH last AS (
                  ${LAST_TRIED} AND f.shop_id = ${tenant.shopId}
                   ORDER BY e.fulfillment_id, e.happened_at DESC, e.id DESC
                )
                SELECT count(*)::int AS total FROM last WHERE status = 'attempted_delivery'`)
            ).rows[0]?.total ?? 0)
          : 0);
      return {
        count,
        parcels: rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          orderNumber: row.number,
          customerName: row.name,
          city: row.city,
          trackingCompany: row.tracking_company,
          trackingNumber: row.tracking_number,
          trackingUrl: row.tracking_url,
          attemptedAt: new Date(row.attempted_at),
          reason: row.message,
          attempts: row.attempts,
          answer: row.answer,
          answeredAt: row.answered_at === null ? null : new Date(row.answered_at),
        })),
      };
    });
  }
}

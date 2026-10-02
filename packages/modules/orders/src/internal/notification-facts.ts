import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { CancelReasonValue, OrderSourceValue, ParcelStatusValue } from './schema.js';

/**
 * What a message about an order tells its customer (MSG-01, ADR-146): the order by its number,
 * its total, whom to write to, and the parcel it is about, by its courier and tracking.
 */
export interface OrderNotificationFacts {
  id: string;
  number: number;
  source: OrderSourceValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  customerId: string;
  /** Whether the customer's data was erased (CUS-05): no number is left to write to. */
  erased: boolean;
  /** In E.164: "+923001234567". */
  phone: string | null;
  /** As its address has it. */
  name: string | null;
  cancelReason: CancelReasonValue | null;
  /** The parcel asked about, when one was. */
  parcel: {
    status: ParcelStatusValue;
    company: string | null;
    number: string | null;
    url: string | null;
  } | null;
}

/** The order `orderId`, and its parcel `parcelId`, as a message tells of them; null if gone. */
export async function orderNotificationFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  parcelId?: string | null,
): Promise<OrderNotificationFacts | null> {
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    source: OrderSourceValue;
    currency: string;
    total: string;
    customer_id: string;
    erased: boolean;
    phone: string | null;
    name: string | null;
    cancel_reason: CancelReasonValue | null;
    tracking_company: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    parcel_status: ParcelStatusValue | null;
  }>(sql`
    SELECT o.id, o.number, o.source, o.currency, o.total, o.customer_id,
           o.customer_erased_at IS NOT NULL AS erased, o.phone,
           o.shipping_address ->> 'name' AS name, o.cancel_reason,
           f.tracking_company, f.tracking_number, f.tracking_url, f.status AS parcel_status
      FROM orders.orders o
      LEFT JOIN orders.fulfillments f
        ON f.shop_id = o.shop_id AND f.order_id = o.id AND f.id = ${parcelId ?? null}::uuid
     WHERE o.shop_id = ${shopId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    source: row.source,
    currency: row.currency,
    total: BigInt(row.total),
    customerId: row.customer_id,
    erased: row.erased,
    phone: row.phone,
    name: row.name,
    cancelReason: row.cancel_reason,
    parcel: row.parcel_status
      ? {
          status: row.parcel_status,
          company: row.tracking_company,
          number: row.tracking_number,
          url: row.tracking_url,
        }
      : null,
  };
}

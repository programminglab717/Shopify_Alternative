import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { AttributionValue } from './attribution.js';
import type { BrowserIdsValue } from './browser-ids.js';
import type { ConfirmationStatusValue, OrderSourceValue } from './schema.js';

/**
 * What an order's conversions tell the ad platforms (MKT-10, ADR-143): what was bought and for
 * how much, who bought it, where they placed it from, the visits that brought them and the IDs
 * the shop's Meta pixel gave their browser (ADR-144). The marketing module hashes the customer's
 * details before they leave.
 */
export interface OrderConversionFacts {
  id: string;
  number: number;
  source: OrderSourceValue;
  confirmationStatus: ConfirmationStatusValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  customerId: string;
  /** Whether the customer's data was erased (CUS-05): what follows is null, or nearly. */
  erased: boolean;
  /** In E.164: "+923001234567". */
  phone: string | null;
  email: string | null;
  /** As its address has it. */
  name: string | null;
  city: string | null;
  zip: string | null;
  /** Where its customer placed it from (ADR-057). */
  clientIp: string | null;
  clientUserAgent: string | null;
  /** The visits that brought them, as checkout kept them (ADR-139). */
  attribution: AttributionValue | null;
  /** The IDs the shop's Meta pixel gave their browser, as checkout passed them (ADR-144). */
  browserIds: BrowserIdsValue | null;
  /** Its items now, in their order. */
  lines: { variantId: string; quantity: number; unitPrice: bigint }[];
}

/** Orders `ids` of the shop as their conversions tell of them, in the caller's transaction. */
export async function orderConversionFactsIn(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<OrderConversionFacts[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    source: OrderSourceValue;
    confirmation_status: ConfirmationStatusValue;
    currency: string;
    total: string;
    customer_id: string;
    erased: boolean;
    phone: string | null;
    email: string | null;
    name: string | null;
    city: string | null;
    zip: string | null;
    client_ip: string | null;
    client_user_agent: string | null;
    attribution: AttributionValue | null;
    browser_ids: BrowserIdsValue | null;
    lines: { variantId: string; quantity: number; unitPrice: string }[];
  }>(sql`
    SELECT o.id, o.number, o.source, o.confirmation_status, o.currency, o.total, o.customer_id,
           o.customer_erased_at IS NOT NULL AS erased, o.phone, o.email,
           o.shipping_address ->> 'name' AS name, o.shipping_address ->> 'city' AS city,
           o.shipping_address ->> 'zip' AS zip, host(o.client_ip) AS client_ip,
           o.client_user_agent, o.attribution, o.browser_ids,
           coalesce((SELECT jsonb_agg(jsonb_build_object('variantId', l.variant_id,
                                                         'quantity', l.quantity,
                                                         'unitPrice', l.unit_price::text)
                                      ORDER BY l.position)
                       FROM orders.lines l
                      WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.id = ANY(${sql.param([...new Set(ids)])}::uuid[])`);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    source: row.source,
    confirmationStatus: row.confirmation_status,
    currency: row.currency,
    total: BigInt(row.total),
    customerId: row.customer_id,
    erased: row.erased,
    phone: row.phone,
    email: row.email,
    name: row.name,
    city: row.city,
    zip: row.zip,
    clientIp: row.client_ip,
    clientUserAgent: row.client_user_agent,
    attribution: row.attribution,
    browserIds: row.browser_ids,
    lines: row.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: BigInt(line.unitPrice),
    })),
  }));
}

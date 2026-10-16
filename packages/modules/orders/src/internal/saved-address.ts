import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { AddressValue } from './schema.js';

/** The address a number's last order went to, and the email it gave, as checkout fills them in. */
export interface SavedAddress {
  address: AddressValue;
  email: string | null;
}

/**
 * Where the shop last delivered an order of `phone`'s, in E.164 (CHK-03, ADR-447): the address of
 * its newest order sent to an address, as last corrected, with the email it gave; null for none.
 * Orders cancelled, picked up, or whose customer's data was erased say nothing. Checkout asks
 * only once the shopper proved the number is theirs.
 */
export async function savedAddressIn(
  tx: Tx,
  shopId: string,
  phone: string,
): Promise<SavedAddress | null> {
  const { rows } = await tx.execute<{ shipping_address: AddressValue; email: string | null }>(sql`
    SELECT shipping_address, email FROM orders.orders
     WHERE shop_id = ${shopId} AND phone = ${phone} AND delivery_method = 'shipping'
       AND cancelled_at IS NULL AND shipping_address->>'address1' IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`);
  const row = rows[0];
  return row ? { address: row.shipping_address, email: row.email } : null;
}

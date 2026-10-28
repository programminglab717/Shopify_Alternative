import type { Tx } from '@hatti/db';
import type { AddressValue, SavedAddress } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';

// Hatti Pass (CUS-08, ADR-867): a shopper's name, email and address, kept by Hatti for any Hatti
// shop's checkout, with their consent, by the number they proved. Checkout fills its form in from
// it once the shopper proves the number again, where the shop has no order of theirs to fill it
// from; the shopper saves it by ticking a box as they place an order, and forgets it from any
// checkout. Only what the form needs is kept.

/**
 * Whether checkout offers Hatti Pass: off until Hatti's privacy policy says Hatti keeps shoppers'
 * details it saves with their consent (OWN-57), then on for every shop.
 */
export class HattiPassSetting {
  constructor(readonly on: boolean) {}
}

/** The box checkout's form ticks to save the order's details to the shopper's Hatti Pass. */
export const PASS_FIELD = 'hatti_pass';

/** The shopper's Hatti Pass, as checkout fills its form in from it; null for none. */
export async function passAddressIn(tx: Tx, phone: string): Promise<SavedAddress | null> {
  const { rows } = await tx.execute<{
    name: string;
    email: string | null;
    address: Omit<AddressValue, 'name' | 'phone'>;
  }>(sql`
    UPDATE platform.hatti_passes SET used_at = now() WHERE phone = ${phone}
    RETURNING name, email, address`);
  const row = rows[0];
  return row ? { address: { ...row.address, name: row.name, phone }, email: row.email } : null;
}

/** Saves an order's details as the shopper's Hatti Pass, replacing what it had. */
export async function savePassIn(
  tx: Tx,
  shopId: string,
  input: { address: AddressValue; email: string | null },
): Promise<void> {
  const { name, phone, address1, address2, landmark, city, provinceCode, location } = input.address;
  const address = { address1, address2, landmark, city, provinceCode, zip: null, location };
  await tx.execute(sql`
    INSERT INTO platform.hatti_passes
           (phone, name, email, address, saved_at_shop, consented_at, updated_at)
    VALUES (${phone}, ${name}, ${input.email}, ${JSON.stringify(address)}::jsonb, ${shopId},
            now(), now())
    ON CONFLICT (phone) DO UPDATE
       SET name = excluded.name, email = excluded.email, address = excluded.address,
           saved_at_shop = excluded.saved_at_shop, consented_at = excluded.consented_at,
           updated_at = now()`);
}

/** Forgets the shopper's Hatti Pass: whether there was one. */
export async function forgetPassIn(tx: Tx, phone: string): Promise<boolean> {
  const { rows } = await tx.execute<{ phone: string }>(sql`
    DELETE FROM platform.hatti_passes WHERE phone = ${phone} RETURNING phone`);
  return rows.length > 0;
}

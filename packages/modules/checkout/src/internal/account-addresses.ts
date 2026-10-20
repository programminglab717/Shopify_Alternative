import type { InputChecker } from '@hatti/api';
import { toDate, type Tx } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { checkAddress, type AddressValue } from '@hatti/orders/public';
import { PK_PROVINCES, type PkProvinceCode } from '@hatti/pk';
import {
  ACCOUNT_ADDRESSES_MAX,
  type AccountAddress,
  type AccountAddressRequest,
} from '@hatti/storefront-api';
import { sql } from 'drizzle-orm';

// Shoppers' address books, kept with their accounts (CUS-02, ADR-583), as Shopify's customers keep
// theirs: each address checked as checkout's shipping address is, and kept in its shape; one of
// them the default while there are any, the first saved becoming it, and the newest left becoming
// it when the default goes; at most {@link ACCOUNT_ADDRESSES_MAX}. A book is a customer's: a number
// no customer has yet keeps none, its addresses coming with its first order.

/** An address in a book, as kept. */
export interface AccountAddressRecord {
  id: string;
  address: AddressValue;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type AddressRow = {
  id: string;
  address: AddressValue;
  is_default: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

function toRecord(row: AddressRow): AccountAddressRecord {
  return {
    id: row.id,
    address: row.address,
    isDefault: row.is_default,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** An address as the storefront's account shows it. */
export function toAccountAddress(record: AccountAddressRecord): AccountAddress {
  const { address } = record;
  return {
    id: toPublicId('accountAddress', record.id),
    name: address.name,
    phone: address.phone,
    address1: address.address1,
    address2: address.address2,
    landmark: address.landmark,
    city: address.city,
    provinceCode: address.provinceCode,
    province: address.provinceCode
      ? (PK_PROVINCES[address.provinceCode as PkProvinceCode]?.name ?? null)
      : null,
    zip: address.zip,
    default: record.isDefault,
  };
}

/**
 * The customer `customerId`'s book, in the caller's transaction: the default first, then the
 * latest changed.
 */
export async function addressesIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<AccountAddressRecord[]> {
  const { rows } = await tx.execute<AddressRow>(sql`
    SELECT id, address, is_default, created_at, updated_at FROM checkout.account_addresses
     WHERE shop_id = ${shopId} AND customer_id = ${customerId}
     ORDER BY is_default DESC, updated_at DESC, id DESC`);
  return rows.map(toRecord);
}

/**
 * Saves `input` to the customer `customerId`'s book, in the caller's transaction: a new address,
 * or the one `id` names, changed. The first saved, or one asked to be, becomes the default. Null
 * after adding to `check` what was wrong: the address, a book already full, or an address not in
 * it.
 */
export async function saveAddressIn(
  tx: Tx,
  check: InputChecker,
  shopId: string,
  customerId: string,
  input: AccountAddressRequest,
  id: string | null,
): Promise<AccountAddressRecord | null> {
  const address = checkAddress(check, [], { ...input, latitude: null, longitude: null });
  if (!address) return null;
  // The book, locked, so that two saves at once count and pick its default alike.
  const { rows: book } = await tx.execute<{ id: string; is_default: boolean }>(sql`
    SELECT id, is_default FROM checkout.account_addresses
     WHERE shop_id = ${shopId} AND customer_id = ${customerId}
     FOR UPDATE`);
  if (id !== null && !book.some((row) => row.id === id)) {
    check.add(['id'], 'NOT_FOUND', 'is not one of your addresses');
    return null;
  }
  if (id === null && book.length >= ACCOUNT_ADDRESSES_MAX) {
    check.addMessage(
      [],
      'TOO_MANY',
      `You can keep ${ACCOUNT_ADDRESSES_MAX} addresses: remove one to add another`,
    );
    return null;
  }
  const makeDefault = input.default === true || !book.some((row) => row.is_default);
  if (makeDefault) {
    await tx.execute(sql`
      UPDATE checkout.account_addresses SET is_default = false
       WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND is_default`);
  }
  const { rows } =
    id === null
      ? await tx.execute<AddressRow>(sql`
          INSERT INTO checkout.account_addresses (shop_id, customer_id, address, is_default)
          VALUES (${shopId}, ${customerId}, ${JSON.stringify(address)}::jsonb, ${makeDefault})
          RETURNING id, address, is_default, created_at, updated_at`)
      : await tx.execute<AddressRow>(sql`
          UPDATE checkout.account_addresses
             SET address = ${JSON.stringify(address)}::jsonb,
                 is_default = is_default OR ${makeDefault}, updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${id}
          RETURNING id, address, is_default, created_at, updated_at`);
  return toRecord(rows[0]!);
}

/**
 * Takes the address `id` out of the customer `customerId`'s book, in the caller's transaction: the
 * newest left becomes the default, where it was. Whether it was in the book.
 */
export async function deleteAddressIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await tx.execute<{ is_default: boolean }>(sql`
    DELETE FROM checkout.account_addresses
     WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND id = ${id}
    RETURNING is_default`);
  if (rows.length === 0) return false;
  if (rows[0]!.is_default) await keepDefaultIn(tx, shopId, customerId);
  return true;
}

/**
 * Puts the customer `fromId`'s addresses in `intoId`'s book, in the caller's transaction, as a
 * merge does: `intoId`'s default stays, and the newest {@link ACCOUNT_ADDRESSES_MAX} are kept.
 */
export async function joinAddressesIn(
  tx: Tx,
  shopId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  if (fromId === intoId) return;
  const { rows } = await tx.execute(sql`
    UPDATE checkout.account_addresses moved
       SET customer_id = ${intoId},
           is_default = moved.is_default AND NOT EXISTS (
             SELECT 1 FROM checkout.account_addresses kept
              WHERE kept.shop_id = ${shopId} AND kept.customer_id = ${intoId} AND kept.is_default)
     WHERE moved.shop_id = ${shopId} AND moved.customer_id = ${fromId}
    RETURNING moved.id`);
  if (rows.length === 0) return;
  await tx.execute(sql`
    DELETE FROM checkout.account_addresses
     WHERE shop_id = ${shopId} AND customer_id = ${intoId}
       AND id NOT IN (SELECT id FROM checkout.account_addresses
                       WHERE shop_id = ${shopId} AND customer_id = ${intoId}
                       ORDER BY is_default DESC, updated_at DESC, id DESC
                       LIMIT ${ACCOUNT_ADDRESSES_MAX})`);
  await keepDefaultIn(tx, shopId, intoId);
}

/** Makes the newest of the customer's addresses the default, while none is. */
async function keepDefaultIn(tx: Tx, shopId: string, customerId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE checkout.account_addresses SET is_default = true
     WHERE shop_id = ${shopId}
       AND id = (SELECT id FROM checkout.account_addresses
                  WHERE shop_id = ${shopId} AND customer_id = ${customerId}
                  ORDER BY updated_at DESC, id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM checkout.account_addresses
                        WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND is_default)`);
}

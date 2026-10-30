import { productsAndCollectionsIn } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { ACCOUNT_VIEWED_MAX, ACCOUNT_WISHLIST_MAX } from '@hatti/storefront-api';
import { sql, type SQL } from 'drizzle-orm';

// Shoppers' wishlists, kept with their accounts (OS-12, CUS-02, ADR-575). A wishlist is the
// customer's whose number signed in, so that every number of theirs reads the same one, and a
// merge joins two; a number no customer has keeps its own, by the number, until it becomes a
// customer's, as when it places its first order, and its list goes to them the next time its
// account is read. A product is in a list once, with when it was added; the newest
// {@link ACCOUNT_WISHLIST_MAX} are kept, the oldest going to make room, as the browser's own list
// lets its oldest go. A product the shop no longer has leaves the list once it is read. The products
// a shopper viewed are kept the same way, a list of their own (ADR-978): viewed again, one moves to
// the top, and the newest {@link ACCOUNT_VIEWED_MAX} are kept.

/** Which of an account's lists: its wishlist, or the products it viewed (ADR-978). */
export type AccountList = 'wishlist' | 'viewed';

const MOST: Record<AccountList, number> = {
  wishlist: ACCOUNT_WISHLIST_MAX,
  viewed: ACCOUNT_VIEWED_MAX,
};

/** Whose wishlist: a customer's, or, while it has none, the number's that signed in. */
export type WishlistOwner = { customerId: string } | { phone: string };

/** The rows of `owner`'s list. */
function ownedBy(shopId: string, owner: WishlistOwner): SQL {
  return 'customerId' in owner
    ? sql`shop_id = ${shopId} AND customer_id = ${owner.customerId}`
    : sql`shop_id = ${shopId} AND phone = ${owner.phone}`;
}

/** A product once in each of `owner`'s lists: the unique index its rows fall under. */
function conflictOf(owner: WishlistOwner): SQL {
  return 'customerId' in owner
    ? sql`(shop_id, list, customer_id, product_id) WHERE customer_id IS NOT NULL`
    : sql`(shop_id, list, phone, product_id) WHERE phone IS NOT NULL`;
}

/**
 * The wishlist of the session of `phone`, read as the customer `customerId` it is now, in the
 * caller's transaction: the customer's, once the number's own list, kept while it had none, has
 * joined it; the number's while it has none.
 */
export async function wishlistOwnerIn(
  tx: Tx,
  shopId: string,
  session: { phone: string; customerId: string | null },
): Promise<WishlistOwner> {
  if (!session.customerId) return { phone: session.phone };
  const owner = { customerId: session.customerId };
  await joinWishlistIn(tx, shopId, { phone: session.phone }, owner);
  return owner;
}

/**
 * Puts the lists of `from` in `into`'s, in the caller's transaction, each in its own (ADR-978):
 * each product once, added when it was added last to either, and the newest of each kept. Running
 * it twice changes nothing.
 */
export async function joinWishlistIn(
  tx: Tx,
  shopId: string,
  from: WishlistOwner,
  into: { customerId: string },
): Promise<void> {
  if ('customerId' in from && from.customerId === into.customerId) return;
  const { rows } = await tx.execute(sql`
    WITH moved AS (
      DELETE FROM checkout.account_wishlist_items WHERE ${ownedBy(shopId, from)}
      RETURNING list, product_id, added_at
    )
    INSERT INTO checkout.account_wishlist_items (shop_id, list, customer_id, product_id, added_at)
    SELECT ${shopId}, list, ${into.customerId}::uuid, product_id, added_at FROM moved
    ON CONFLICT ${conflictOf(into)}
    DO UPDATE SET added_at = greatest(account_wishlist_items.added_at, excluded.added_at)
    RETURNING id`);
  if (rows.length === 0) return;
  await keepNewestIn(tx, shopId, into, 'wishlist');
  await keepNewestIn(tx, shopId, into, 'viewed');
}

/**
 * Of `owner`'s list, its wishlist unless `list` names the other, the products the shop still has,
 * the newest first, in the caller's transaction; those it no longer has leave the list.
 */
export async function wishlistIn(
  tx: Tx,
  shopId: string,
  owner: WishlistOwner,
  list: AccountList = 'wishlist',
): Promise<string[]> {
  const { rows } = await tx.execute<{ product_id: string }>(sql`
    SELECT product_id FROM checkout.account_wishlist_items
     WHERE ${ownedBy(shopId, owner)} AND list = ${list}
     ORDER BY added_at DESC, product_id`);
  const listed = rows.map((row) => row.product_id);
  if (listed.length === 0) return [];
  const { productIds: had } = await productsAndCollectionsIn(tx, shopId, {
    productIds: listed,
    collectionIds: [],
  });
  const gone = listed.filter((id) => !had.has(id));
  if (gone.length > 0) {
    await tx.execute(sql`
      DELETE FROM checkout.account_wishlist_items
       WHERE ${ownedBy(shopId, owner)} AND list = ${list}
         AND product_id = ANY(${sql.param(gone)}::uuid[])`);
  }
  return listed.filter((id) => had.has(id));
}

/**
 * Adds `productIds`, the newest first, to `owner`'s list, its wishlist unless `list` names the
 * other, in the caller's transaction: those the shop has, each once; those already in the wishlist
 * stay where they are, and those already viewed move to the top (ADR-978). The newest of the list
 * are kept.
 */
export async function addToWishlistIn(
  tx: Tx,
  shopId: string,
  owner: WishlistOwner,
  productIds: readonly string[],
  list: AccountList = 'wishlist',
): Promise<void> {
  const asked = [...new Set(productIds)];
  if (asked.length === 0) return;
  const { productIds: had } = await productsAndCollectionsIn(tx, shopId, {
    productIds: asked,
    collectionIds: [],
  });
  const added = asked.filter((id) => had.has(id));
  if (added.length === 0) return;
  const [customerId, phone] =
    'customerId' in owner ? [owner.customerId, null] : [null, owner.phone];
  // The first named the newest: each a microsecond before the one named before it.
  await tx.execute(sql`
    INSERT INTO checkout.account_wishlist_items
           (shop_id, list, customer_id, phone, product_id, added_at)
    SELECT ${shopId}, ${list}, ${customerId}::uuid, ${phone}::text, asked.product_id,
           now() - (asked.position - 1) * interval '1 microsecond'
      FROM unnest(${sql.param(added)}::uuid[]) WITH ORDINALITY AS asked (product_id, position)
    ON CONFLICT ${conflictOf(owner)}
    ${list === 'viewed' ? sql`DO UPDATE SET added_at = excluded.added_at` : sql`DO NOTHING`}`);
  await keepNewestIn(tx, shopId, owner, list);
}

/** Takes the product `productId` off `owner`'s list, in the caller's transaction. */
export async function removeFromWishlistIn(
  tx: Tx,
  shopId: string,
  owner: WishlistOwner,
  productId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM checkout.account_wishlist_items
     WHERE ${ownedBy(shopId, owner)} AND list = 'wishlist' AND product_id = ${productId}`);
}

/** Lets the oldest of `owner`'s `list` go past the newest it keeps. */
async function keepNewestIn(
  tx: Tx,
  shopId: string,
  owner: WishlistOwner,
  list: AccountList,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM checkout.account_wishlist_items
     WHERE ${ownedBy(shopId, owner)} AND list = ${list}
       AND id NOT IN (SELECT id FROM checkout.account_wishlist_items
                       WHERE ${ownedBy(shopId, owner)} AND list = ${list}
                       ORDER BY added_at DESC, product_id
                       LIMIT ${MOST[list]})`);
}

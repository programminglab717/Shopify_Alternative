import { sha256 } from '@hatti/crypto';
import { customerTagsOfPhoneIn } from '@hatti/customers/public';
import type { Tx } from '@hatti/db';
import { listPricesIn } from '@hatti/pricing/public';
import { sql } from 'drizzle-orm';
import type { StoredLine, VariantFacts } from './cart-lines.js';

/**
 * The account session `token` names while it lasts (ADR-780): the shopper signed in to their
 * account on the shop, whose carts are priced from their price lists. Null for none.
 */
export async function accountSessionIdIn(
  tx: Tx,
  shopId: string,
  token: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM checkout.account_sessions
     WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)}
       AND revoked_at IS NULL AND expires_at > now()`);
  return rows[0]?.id ?? null;
}

/** The number account session `id` signed in with, while it lasts; null once it ended. */
async function sessionPhoneIn(tx: Tx, shopId: string, id: string): Promise<string | null> {
  const { rows } = await tx.execute<{ phone: string }>(sql`
    SELECT phone FROM checkout.account_sessions
     WHERE shop_id = ${shopId} AND id = ${id}
       AND revoked_at IS NULL AND expires_at > now()`);
  return rows[0]?.phone ?? null;
}

/**
 * `facts` with each variant of `lines` priced for the shopper signed in with account session
 * `sessionId` (CUS-06, ADR-780): from the price lists of the tags their customer has, by how many
 * of the variant the lines hold together, as drafts are (ADR-778). A list never prices above the
 * price to anyone; without a session that lasts, a customer, tags or a list, `facts` as they are.
 */
export async function wholesaleFactsIn(
  tx: Tx,
  shopId: string,
  sessionId: string | null,
  lines: readonly StoredLine[],
  facts: ReadonlyMap<string, VariantFacts>,
): Promise<ReadonlyMap<string, VariantFacts>> {
  if (sessionId === null || lines.length === 0) return facts;
  const phone = await sessionPhoneIn(tx, shopId, sessionId);
  if (phone === null) return facts;
  const tags = await customerTagsOfPhoneIn(tx, shopId, phone);
  if (tags.length === 0) return facts;
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (!facts.has(line.variantId)) continue;
    quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity);
  }
  const wanted = [...quantities];
  const prices = await listPricesIn(
    tx,
    shopId,
    tags,
    wanted.map(([variantId, quantity]) => ({
      variantId,
      quantity,
      price: facts.get(variantId)!.price,
    })),
  );
  if (prices.every((each) => each === null)) return facts;
  const priced = new Map(facts);
  wanted.forEach(([variantId], index) => {
    const listed = prices[index];
    if (listed) priced.set(variantId, { ...facts.get(variantId)!, price: listed.price });
  });
  return priced;
}

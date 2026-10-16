import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

/**
 * Which of the products `productIds` are gift cards (CAT-12, ADR-451): a unit of one sold is a
 * card worth its price, issued once its order is paid.
 */
export async function giftCardProductIdsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM catalog.products
     WHERE shop_id = ${shopId} AND gift_card
       AND id = ANY(${sql.param([...new Set(productIds)])}::uuid[])`);
  return new Set(rows.map((row) => row.id));
}

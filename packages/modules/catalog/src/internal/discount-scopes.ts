import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

/**
 * Of `productIds` and `collectionIds`, those the shop has (ADR-517): what a discount for some
 * products or collections may name.
 */
export async function productsAndCollectionsIn(
  tx: Tx,
  shopId: string,
  ids: { productIds: readonly string[]; collectionIds: readonly string[] },
): Promise<{ productIds: Set<string>; collectionIds: Set<string> }> {
  const found = async (table: 'products' | 'collections', wanted: readonly string[]) => {
    if (wanted.length === 0) return new Set<string>();
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM ${sql.raw(`catalog.${table}`)}
       WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...new Set(wanted)])}::uuid[])`);
    return new Set(rows.map((row) => row.id));
  };
  return {
    productIds: await found('products', ids.productIds),
    collectionIds: await found('collections', ids.collectionIds),
  };
}

/** Of `variantIds`, those the shop has: what a price list may give prices of (ADR-778). */
export async function variantsIn(
  tx: Tx,
  shopId: string,
  variantIds: readonly string[],
): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM catalog.variants
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...new Set(variantIds)])}::uuid[])`);
  return new Set(rows.map((row) => row.id));
}

/**
 * Which of `collectionIds` each of `productIds` is in, in one query (ADR-517): what checkout asks
 * of a cart's products for discounts given to collections. Products in none are left out.
 */
export async function collectionsOfProductsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
  collectionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byProduct = new Map<string, string[]>();
  if (productIds.length === 0 || collectionIds.length === 0) return byProduct;
  const { rows } = await tx.execute<{ product_id: string; collection_id: string }>(sql`
    SELECT product_id, collection_id FROM catalog.collection_products
     WHERE shop_id = ${shopId}
       AND product_id = ANY(${sql.param([...new Set(productIds)])}::uuid[])
       AND collection_id = ANY(${sql.param([...new Set(collectionIds)])}::uuid[])`);
  for (const row of rows) {
    byProduct.set(row.product_id, [...(byProduct.get(row.product_id) ?? []), row.collection_id]);
  }
  return byProduct;
}

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

/** A variant as a list of prices names it: its product's title, its own and its price to anyone. */
export interface VariantName {
  productTitle: string;
  /** Null for a product's only variant, as the admin shows it. */
  variantTitle: string | null;
  /** Minor units. */
  price: bigint;
}

/** The names and prices of those of `variantIds` the shop has, in one query (ADR-779). */
export async function variantNamesIn(
  tx: Tx,
  shopId: string,
  variantIds: readonly string[],
): Promise<Map<string, VariantName>> {
  if (variantIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    id: string;
    product_title: string;
    title: string;
    only: boolean;
    price: string;
  }>(sql`
    SELECT v.id, p.title AS product_title, v.title, v.price::text AS price,
           NOT EXISTS (SELECT 1 FROM catalog.variants o
                        WHERE o.shop_id = v.shop_id AND o.product_id = v.product_id
                          AND o.id <> v.id) AS only
      FROM catalog.variants v
      JOIN catalog.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
     WHERE v.shop_id = ${shopId} AND v.id = ANY(${sql.param([...new Set(variantIds)])}::uuid[])`);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        productTitle: row.product_title,
        variantTitle: row.only ? null : row.title,
        price: BigInt(row.price),
      },
    ]),
  );
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

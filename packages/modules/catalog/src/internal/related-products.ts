import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

/** The related products a product's page may show, at most (MKT-09, ADR-434). */
export const RELATED_PRODUCTS = 10;

/**
 * Of the products a collection holds, those weighed as related to one of its products: enough for
 * a page, without reading every product of a collection that holds them all.
 */
const COLLECTION_CANDIDATES = 200;

/** Of a type's, or a vendor's, products, those weighed as related. */
const KIND_CANDIDATES = 100;

/**
 * Each of `productIds`' related products, in the caller's transaction (MKT-09, ADR-434): the
 * shop's other products for sale, those sharing more of its collections first, then those of its
 * type, then its vendor's, the newest first among equals; at most {@link RELATED_PRODUCTS} each.
 * A product with none has none in the map.
 */
export async function relatedProductsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ product_id: string; related: string[] }>(sql`
    SELECT me.id AS product_id,
           ARRAY(
             SELECT c.id
               FROM (
                 (SELECT cp.product_id AS id, 100 AS weight
                    FROM catalog.collection_products m
                    JOIN LATERAL (
                      SELECT product_id FROM catalog.collection_products cp
                       WHERE cp.shop_id = m.shop_id AND cp.collection_id = m.collection_id
                         AND cp.product_id <> me.id
                       ORDER BY cp.position, cp.product_id
                       LIMIT ${COLLECTION_CANDIDATES}) cp ON true
                   WHERE m.shop_id = me.shop_id AND m.product_id = me.id)
                 UNION ALL
                 (SELECT p.id, 10 FROM catalog.products p
                   WHERE p.shop_id = me.shop_id AND p.status = 'active' AND p.id <> me.id
                     AND p.product_type IS NOT NULL AND p.product_type <> ''
                     AND p.product_type = me.product_type
                   ORDER BY p.created_at DESC
                   LIMIT ${KIND_CANDIDATES})
                 UNION ALL
                 (SELECT p.id, 1 FROM catalog.products p
                   WHERE p.shop_id = me.shop_id AND p.status = 'active' AND p.id <> me.id
                     AND p.vendor IS NOT NULL AND p.vendor <> '' AND p.vendor = me.vendor
                   ORDER BY p.created_at DESC
                   LIMIT ${KIND_CANDIDATES})
               ) c
               JOIN catalog.products p
                 ON p.shop_id = me.shop_id AND p.id = c.id AND p.status = 'active'
              GROUP BY c.id, p.created_at
              ORDER BY sum(c.weight) DESC, p.created_at DESC, c.id
              LIMIT ${RELATED_PRODUCTS}
           ) AS related
      FROM catalog.products me
     WHERE me.shop_id = ${shopId} AND me.id = ANY(${sql.param([...productIds])}::uuid[])`);
  return new Map(
    rows.filter((row) => row.related.length > 0).map((row) => [row.product_id, row.related]),
  );
}

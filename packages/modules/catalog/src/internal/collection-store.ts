import type { TenantContext } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { checkRules, compileRules } from './collection-rules.js';
import { collections } from './schema.js';

/**
 * Brings smart collection membership up to date, in the same transaction as the change that
 * affects it, so reads never see a stale collection.
 *
 * - `productIds`: products were created or changed; every smart collection re-checks them.
 * - `collectionIds`: rules changed; those collections re-check every product in the shop.
 *
 * Either way it is one statement: rules compile to SQL, and matches are inserted and stale rows
 * deleted together.
 */
export async function refreshMemberships(
  tx: Tx,
  tenant: TenantContext,
  scope: { productIds: string[] } | { collectionIds: string[] },
): Promise<void> {
  const conditions = [eq(collections.shopId, tenant.shopId), isNotNull(collections.rules)];
  if ('collectionIds' in scope) {
    if (scope.collectionIds.length === 0) return;
    conditions.push(inArray(collections.id, scope.collectionIds));
  } else if (scope.productIds.length === 0) {
    return;
  }
  const smart = await tx
    .select({ id: collections.id, rules: collections.rules, disjunctive: collections.disjunctive })
    .from(collections)
    .where(and(...conditions));
  if (smart.length === 0) return;

  const productFilter =
    'productIds' in scope ? sql`AND p.id = ANY(${sql.param(scope.productIds)}::uuid[])` : sql``;
  const matches = smart.map((collection) => {
    const checked = checkRules(collection.rules ?? [], tenant.currency);
    // Rules are checked when saved; a rule that no longer parses matches nothing.
    const condition = checked.ok ? compileRules(checked.rules, collection.disjunctive) : sql`false`;
    return sql`SELECT ${collection.id}::uuid AS collection_id, p.id AS product_id
                 FROM catalog.products p
                WHERE p.shop_id = ${tenant.shopId} ${productFilter} AND (${condition})`;
  });
  const smartIds = smart.map((collection) => collection.id);
  const staleFilter =
    'productIds' in scope
      ? sql`AND cp.product_id = ANY(${sql.param(scope.productIds)}::uuid[])`
      : sql``;
  await tx.execute(sql`
    WITH matches AS (${sql.join(matches, sql` UNION ALL `)}),
    stale AS (
      DELETE FROM catalog.collection_products cp
       WHERE cp.shop_id = ${tenant.shopId}
         AND cp.collection_id = ANY(${sql.param(smartIds)}::uuid[])
         ${staleFilter}
         AND NOT EXISTS (SELECT 1 FROM matches m
                          WHERE m.collection_id = cp.collection_id
                            AND m.product_id = cp.product_id)
    )
    INSERT INTO catalog.collection_products (shop_id, collection_id, product_id)
    SELECT ${tenant.shopId}, collection_id, product_id FROM matches
    ON CONFLICT DO NOTHING`);
}

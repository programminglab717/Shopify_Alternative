import { failOne, type FieldError, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { loadProducts } from './product-store.js';
import type { ProductRecord } from './records.js';

/** Events of the products a shop pairs with others. Payloads are thin. */
export const ComplementEvents = {
  /** A product was paired with other products, or its pairings changed or were taken away. */
  Updated: 'product_complements.updated',
} as const;

/** How many products a shop pairs with one, at most (MKT-09, ADR-435), as Shopify allows. */
export const COMPLEMENTARY_PRODUCTS = 10;

/**
 * Each of `productIds`' complementary products, in the caller's transaction (MKT-09, ADR-435):
 * those the shop pairs with it, in the order it gave them, whatever their status; a storefront
 * shows only those it sells. A product with none has none in the map.
 */
export async function complementsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ product_id: string; complement_id: string }>(sql`
    SELECT product_id, complement_id FROM catalog.product_complements
     WHERE shop_id = ${shopId} AND product_id = ANY(${sql.param([...productIds])}::uuid[])
     ORDER BY product_id, position`);
  const complements = new Map<string, string[]>();
  for (const row of rows) {
    const list = complements.get(row.product_id) ?? [];
    list.push(row.complement_id);
    complements.set(row.product_id, list);
  }
  return complements;
}

/** The products a shop pairs with others, shown where a page or cart asks for them (MKT-09). */
@Injectable()
export class ComplementService {
  constructor(private readonly db: Database) {}

  /** Each of `productIds`' complementary products, in order. */
  async of(tenant: TenantContext, productIds: readonly string[]): Promise<Map<string, string[]>> {
    return this.db.tenant(tenant.shopId, (tx) => complementsIn(tx, tenant.shopId, productIds));
  }

  /** Each of `productIds`' complementary products as records, in order. */
  async productsOf(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, ProductRecord[]>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const complements = await complementsIn(tx, tenant.shopId, productIds);
      const ids = [...new Set([...complements.values()].flat())];
      if (ids.length === 0) return new Map();
      const records = new Map(
        (
          await loadProducts(tx, tenant.shopId, {
            where: sql`p.id = ANY(${sql.param(ids)}::uuid[])`,
          })
        ).map((record) => [record.id, record]),
      );
      return new Map(
        [...complements].map(([id, list]) => [
          id,
          list.flatMap((complement) => records.get(complement) ?? []),
        ]),
      );
    });
  }

  /**
   * Pairs a product with `complementIds`, in their order, in place of those it had; none, and it
   * pairs with none. Its complementary products as they are now.
   */
  async set(
    tenant: TenantContext,
    productId: string,
    complementIds: readonly string[],
  ): Promise<MutationResult<string[]>> {
    const errors: FieldError[] = [];
    if (complementIds.length > COMPLEMENTARY_PRODUCTS) {
      errors.push({
        field: ['complementIds'],
        code: 'TOO_MANY',
        message: `A product pairs with ${COMPLEMENTARY_PRODUCTS} products at most`,
      });
    }
    const seen = new Set<string>();
    complementIds.forEach((id, index) => {
      const field = ['complementIds', String(index)];
      if (id === productId) {
        errors.push({ field, code: 'INVALID', message: 'A product cannot pair with itself' });
      } else if (seen.has(id)) {
        errors.push({ field, code: 'TAKEN', message: 'This product is named already' });
      }
      seen.add(id);
    });
    if (errors.length > 0) return { ok: false, errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows: product } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products WHERE shop_id = ${shopId} AND id = ${productId}
           FOR UPDATE`);
      if (!product[0]) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const { rows: found } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...complementIds])}::uuid[])`);
      const known = new Set(found.map((row) => row.id));
      complementIds.forEach((id, index) => {
        if (!known.has(id)) {
          errors.push({
            field: ['complementIds', String(index)],
            code: 'NOT_FOUND',
            message: 'No product of the shop has this ID',
          });
        }
      });
      if (errors.length > 0) return { ok: false, errors };

      const before = (await complementsIn(tx, shopId, [productId])).get(productId) ?? [];
      const same =
        before.length === complementIds.length &&
        before.every((id, index) => id === complementIds[index]);
      if (same) return { ok: true, value: before };
      await tx.execute(sql`
        DELETE FROM catalog.product_complements
         WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      if (complementIds.length > 0) {
        await tx.execute(sql`
          INSERT INTO catalog.product_complements (shop_id, product_id, complement_id, position)
          SELECT ${shopId}, ${productId}, u.id, u.position - 1
            FROM unnest(${sql.param([...complementIds])}::uuid[]) WITH ORDINALITY AS u(id, position)`);
      }
      await appendEvent(tx, shopId, {
        type: ComplementEvents.Updated,
        aggregateType: 'product',
        aggregateId: productId,
        payload: {},
      });
      return { ok: true, value: [...complementIds] };
    });
  }
}

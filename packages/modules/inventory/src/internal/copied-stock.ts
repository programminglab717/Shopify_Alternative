import { CopiedVariantStock, type VariantCopy } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * A duplicated product's variants' stock settings copied to their copies' (ADR-343): tracked or
 * not, and selling on when out of stock or not, as each was; with none of its stock, which no
 * location has until it is set, so a copy of a tracked variant is sold out until then.
 */
@Injectable()
export class InventoryCopiedVariantStock extends CopiedVariantStock {
  async copy(tx: Tx, shopId: string, copies: readonly VariantCopy[]): Promise<void> {
    if (copies.length === 0) return;
    await tx.execute(sql`
      INSERT INTO inventory.items (shop_id, variant_id, product_id, tracked, inventory_policy)
      SELECT i.shop_id, c.to_id, c.product_id, i.tracked, i.inventory_policy
        FROM unnest(${sql.param(copies.map(({ from }) => from))}::uuid[],
                    ${sql.param(copies.map(({ to }) => to))}::uuid[],
                    ${sql.param(copies.map(({ productId }) => productId))}::uuid[])
             AS c(from_id, to_id, product_id)
        JOIN inventory.items i ON i.shop_id = ${shopId} AND i.variant_id = c.from_id
       ORDER BY c.to_id
          ON CONFLICT DO NOTHING`);
  }
}

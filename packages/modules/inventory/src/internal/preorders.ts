import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InventoryEvents, type ProductPreorderUpdatedPayload } from './events.js';

/** How far ahead a pre-order may promise to ship, in days. */
export const PREORDER_LIMITS = { aheadDays: 365 } as const;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Today in Pakistan, where Hatti's shops are, as YYYY-MM-DD: five hours ahead of UTC, with no
 * summer time.
 */
export function pakistanDay(at: Date, plusDays = 0): string {
  return new Date(at.getTime() + 5 * 3_600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** A product on pre-order: the day the shop promises to send what is ordered now. */
export interface PreorderRecord {
  productId: string;
  /** YYYY-MM-DD. */
  shipsOn: string;
}

/**
 * The day each of `productIds` that is on pre-order ships by, as YYYY-MM-DD (CAT-14, ADR-403); the
 * others are left out. In the caller's tenant transaction `tx`, for orders' lines and the
 * storefront's documents.
 */
export async function preordersIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ product_id: string; ships_on: string }>(sql`
    SELECT product_id, to_char(ships_on, 'YYYY-MM-DD') AS ships_on FROM inventory.preorders
     WHERE shop_id = ${shopId}
       AND product_id = ANY(${sql.param([...new Set(productIds)])}::uuid[])`);
  return new Map(rows.map((row) => [row.product_id, row.ships_on]));
}

/**
 * Products put on pre-order (CAT-14, ADR-403). A product on pre-order sells whatever its stock, as
 * if each of its tracked variants kept selling at zero, and says the day it ships by; the lines
 * of orders placed meanwhile keep that day. Taking it off pre-order leaves each variant's own
 * policy as it was.
 */
@Injectable()
export class PreorderService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
  ) {}

  /** The pre-orders among `productIds`, for the Admin API's batch loader. */
  of(tenant: TenantContext, productIds: readonly string[]): Promise<Map<string, string>> {
    return this.db.tenant(tenant.shopId, (tx) => preordersIn(tx, tenant.shopId, productIds));
  }

  /**
   * Puts the product on pre-order, shipping by `shipsOn`, a day from today to a year ahead in
   * Pakistan; or, with null, takes it off. Setting the day it has already is no change.
   */
  async set(
    tenant: TenantContext,
    productId: string,
    shipsOn: string | null,
    at = new Date(),
  ): Promise<MutationResult<PreorderRecord | null>> {
    const check = new InputChecker();
    const day = shipsOn?.trim() ?? null;
    if (day !== null) {
      const match = ISO_DAY.exec(day);
      const real = match && new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
      if (!real || real.toISOString().slice(0, 10) !== day) {
        check.add(['shipsOn'], 'INVALID', 'must be a day, like 2026-11-30');
      } else if (day < pakistanDay(at)) {
        check.add(['shipsOn'], 'INVALID', 'must be today or later');
      } else if (day > pakistanDay(at, PREORDER_LIMITS.aheadDays)) {
        check.add(['shipsOn'], 'INVALID', 'must be within a year');
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      if ((await this.products.handleOf(tx, tenant.shopId, productId)) === null) {
        return failOne(['productId'], 'NOT_FOUND', 'No product of the shop has this ID');
      }
      const before = (await preordersIn(tx, tenant.shopId, [productId])).get(productId) ?? null;
      if (before === day) {
        return { ok: true, value: day === null ? null : { productId, shipsOn: day } };
      }
      if (day === null) {
        await tx.execute(sql`
          DELETE FROM inventory.preorders WHERE shop_id = ${tenant.shopId} AND product_id = ${productId}`);
      } else {
        await tx.execute(sql`
          INSERT INTO inventory.preorders (shop_id, product_id, ships_on)
          VALUES (${tenant.shopId}, ${productId}, ${day}::date)
          ON CONFLICT (shop_id, product_id) DO UPDATE
                SET ships_on = excluded.ships_on, updated_at = now()`);
      }
      await appendEvent<ProductPreorderUpdatedPayload>(tx, tenant.shopId, {
        type: InventoryEvents.ProductPreorderUpdated,
        aggregateType: 'product_preorder',
        aggregateId: productId,
        payload: { productId, shipsOn: day, before },
      });
      return { ok: true, value: day === null ? null : { productId, shipsOn: day } };
    });
  }
}

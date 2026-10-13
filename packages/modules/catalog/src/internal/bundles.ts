import { failOne, type FieldError, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Events of bundles. Payloads are thin: fetch current state through the API. */
export const BundleEvents = {
  /** A product was made a bundle, its parts changed, or it stopped being one. */
  Updated: 'product_bundle.updated',
} as const;

export interface ProductBundleUpdatedPayload {
  /** Its parts' variants, before and after. */
  variantIds: string[];
}

/** How many parts a bundle has at most, and how many of each. */
export const BUNDLE_LIMITS = { parts: 10, quantity: 99 } as const;

/** A part of a bundle: a variant of another product, and how many of it one bundle holds. */
export interface BundleComponent {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
}

export interface BundleRecord {
  productId: string;
  /** Its own variant, the one sold. */
  variantId: string;
  components: BundleComponent[];
  /**
   * False once a part's variant was deleted: the bundle is not sold until the shop gives it its
   * parts again (ADR-409).
   */
  complete: boolean;
}

export interface BundleComponentInput {
  variantId: string;
  quantity: number;
}

type Row = {
  product_id: string;
  own_variant_id: string;
  parts: number;
  variant_id: string | null;
  component_product_id: string | null;
  product_title: string | null;
  variant_title: string | null;
  quantity: number | null;
};

function recordsOf(rows: readonly Row[]): Map<string, BundleRecord> {
  const records = new Map<string, BundleRecord & { parts: number }>();
  for (const row of rows) {
    let record = records.get(row.product_id);
    if (!record) {
      record = {
        productId: row.product_id,
        variantId: row.own_variant_id,
        components: [],
        complete: false,
        parts: row.parts,
      };
      records.set(row.product_id, record);
    }
    if (row.variant_id) {
      record.components.push({
        variantId: row.variant_id,
        productId: row.component_product_id!,
        productTitle: row.product_title!,
        variantTitle: row.variant_title!,
        quantity: row.quantity!,
      });
    }
  }
  return new Map(
    [...records].map(([id, { parts, ...record }]) => [
      id,
      { ...record, complete: record.components.length === parts },
    ]),
  );
}

/** Bundles whose own product or variant `where` picks, in the caller's transaction `tx`. */
async function loadBundles(tx: Tx, shopId: string, where: ReturnType<typeof sql>) {
  const { rows } = await tx.execute<Row>(sql`
    SELECT b.product_id, own.id AS own_variant_id, b.parts,
           c.variant_id, v.product_id AS component_product_id, p.title AS product_title,
           v.title AS variant_title, c.quantity
      FROM catalog.bundles b
      JOIN LATERAL (SELECT id FROM catalog.variants
                     WHERE shop_id = b.shop_id AND product_id = b.product_id
                     ORDER BY position, id LIMIT 1) own ON true
      LEFT JOIN catalog.bundle_components c
             ON c.shop_id = b.shop_id AND c.product_id = b.product_id
      LEFT JOIN catalog.variants v ON v.shop_id = c.shop_id AND v.id = c.variant_id
      LEFT JOIN catalog.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
     WHERE b.shop_id = ${shopId} AND ${where}
     ORDER BY b.product_id, c.position`);
  return recordsOf(rows);
}

/** The bundles among products `productIds`, by product, in the caller's transaction `tx`. */
export async function bundlesOfProductsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, BundleRecord>> {
  if (productIds.length === 0) return new Map();
  return loadBundles(tx, shopId, sql`b.product_id = ANY(${sql.param([...productIds])}::uuid[])`);
}

/**
 * The bundles sold through the variants among `variantIds`, by that variant: what selling one
 * of them sells (ADR-409). In the caller's transaction `tx`.
 */
export async function bundlesOfVariantsIn(
  tx: Tx,
  shopId: string,
  variantIds: readonly string[],
): Promise<Map<string, BundleRecord>> {
  if (variantIds.length === 0) return new Map();
  const byProduct = await loadBundles(
    tx,
    shopId,
    sql`b.product_id IN (SELECT product_id FROM catalog.variants
                          WHERE shop_id = ${shopId}
                            AND id = ANY(${sql.param([...variantIds])}::uuid[]))`,
  );
  const wanted = new Set(variantIds);
  return new Map(
    [...byProduct.values()]
      .filter((record) => wanted.has(record.variantId))
      .map((record) => [record.variantId, record]),
  );
}

/** The shop's bundles' products, in the caller's transaction `tx`. */
export async function bundleProductIdsIn(tx: Tx, shopId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ product_id: string }>(sql`
    SELECT product_id FROM catalog.bundles WHERE shop_id = ${shopId} ORDER BY product_id`);
  return rows.map((row) => row.product_id);
}

/** Whether a product is a bundle, in the caller's transaction `tx`. */
export async function isBundleIn(tx: Tx, shopId: string, productId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM catalog.bundles WHERE shop_id = ${shopId} AND product_id = ${productId}`);
  return rows.length > 0;
}

/** Why a product may not have options or variants of its own: it is a bundle. */
export const BUNDLE_HAS_ONE_VARIANT = 'A bundle has one variant of its own: its parts have options';

/**
 * Bundles and multipacks (CAT-11, ADR-409): a product of one variant, sold as a set of other
 * products' variants, a number of each, which sell from their own stock.
 */
@Injectable()
export class BundleService {
  constructor(private readonly db: Database) {}

  async of(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, BundleRecord>> {
    return this.db.tenant(tenant.shopId, (tx) =>
      bundlesOfProductsIn(tx, tenant.shopId, productIds),
    );
  }

  /**
   * Makes a product a bundle of `components`, in their order, in place of any parts it had, or
   * no longer a bundle when there are none. The bundle as it is now; null once it is none.
   */
  async set(
    tenant: TenantContext,
    productId: string,
    components: readonly BundleComponentInput[],
  ): Promise<MutationResult<BundleRecord | null>> {
    const errors: FieldError[] = [];
    if (components.length > BUNDLE_LIMITS.parts) {
      errors.push({
        field: ['components'],
        code: 'TOO_MANY',
        message: `A bundle has ${BUNDLE_LIMITS.parts} parts at most`,
      });
    }
    const seen = new Set<string>();
    components.forEach((component, index) => {
      if (
        !Number.isInteger(component.quantity) ||
        component.quantity < 1 ||
        component.quantity > BUNDLE_LIMITS.quantity
      ) {
        errors.push({
          field: ['components', String(index), 'quantity'],
          code: 'INVALID',
          message: `A part's quantity must be 1 to ${BUNDLE_LIMITS.quantity}`,
        });
      }
      if (seen.has(component.variantId)) {
        errors.push({
          field: ['components', String(index), 'variantId'],
          code: 'TAKEN',
          message: 'This variant is a part already: give it a quantity instead',
        });
      }
      seen.add(component.variantId);
    });
    const units = components.reduce((sum, component) => sum + component.quantity, 0);
    if (components.length > 0 && units < 2) {
      errors.push({
        field: ['components'],
        code: 'TOO_FEW',
        message: 'A bundle holds two items at least: two variants, or two of one',
      });
    }
    if (errors.length > 0) return { ok: false, errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows: products } = await tx.execute<{ variants: number | string }>(sql`
        SELECT (SELECT count(*) FROM catalog.variants v
                 WHERE v.shop_id = p.shop_id AND v.product_id = p.id) AS variants
          FROM catalog.products p WHERE p.shop_id = ${shopId} AND p.id = ${productId}
           FOR UPDATE`);
      if (!products[0]) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      if (components.length > 0 && Number(products[0].variants) !== 1) {
        return failOne(
          ['productId'],
          'INVALID',
          'A bundle has one variant of its own: take its options away first',
        );
      }
      const { rows: within } = await tx.execute<{ product_id: string }>(sql`
        SELECT DISTINCT c.product_id FROM catalog.bundle_components c
          JOIN catalog.variants v ON v.shop_id = c.shop_id AND v.id = c.variant_id
         WHERE c.shop_id = ${shopId} AND v.product_id = ${productId}`);
      if (components.length > 0 && within.length > 0) {
        return failOne(
          ['productId'],
          'INVALID',
          'This product is a part of another bundle, so it cannot be one itself',
        );
      }
      const ids = components.map((component) => component.variantId);
      const { rows: found } = await tx.execute<{ id: string; product_id: string; bundle: boolean }>(
        sql`
        SELECT v.id, v.product_id,
               EXISTS (SELECT 1 FROM catalog.bundles b
                        WHERE b.shop_id = v.shop_id AND b.product_id = v.product_id) AS bundle
          FROM catalog.variants v
         WHERE v.shop_id = ${shopId} AND v.id = ANY(${sql.param(ids)}::uuid[])`,
      );
      const byId = new Map(found.map((row) => [row.id, row]));
      components.forEach((component, index) => {
        const field = ['components', String(index), 'variantId'];
        const variant = byId.get(component.variantId);
        if (!variant) {
          errors.push({ field, code: 'NOT_FOUND', message: 'No variant of the shop has this ID' });
        } else if (variant.product_id === productId) {
          errors.push({ field, code: 'INVALID', message: 'A bundle cannot hold itself' });
        } else if (variant.bundle) {
          errors.push({
            field,
            code: 'INVALID',
            message: 'A bundle cannot hold another bundle: give it that bundle’s parts',
          });
        }
      });
      if (errors.length > 0) return { ok: false, errors };

      const before = (await bundlesOfProductsIn(tx, shopId, [productId])).get(productId) ?? null;
      const same =
        before?.complete &&
        before.components.length === components.length &&
        before.components.every(
          (part, index) =>
            part.variantId === components[index]!.variantId &&
            part.quantity === components[index]!.quantity,
        );
      if (same || (!before && components.length === 0)) return { ok: true, value: before };

      await tx.execute(sql`
        DELETE FROM catalog.bundle_components WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      if (components.length === 0) {
        await tx.execute(sql`
          DELETE FROM catalog.bundles WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      } else {
        await tx.execute(sql`
          INSERT INTO catalog.bundles (shop_id, product_id, parts)
          VALUES (${shopId}, ${productId}, ${components.length})
          ON CONFLICT (shop_id, product_id)
          DO UPDATE SET parts = excluded.parts, updated_at = now()`);
        await tx.execute(sql`
          INSERT INTO catalog.bundle_components (shop_id, product_id, variant_id, quantity, position)
          SELECT ${shopId}, ${productId}, u.variant_id, u.quantity, u.position
            FROM unnest(${sql.param(ids)}::uuid[],
                        ${sql.param(components.map((component) => component.quantity))}::int[])
                 WITH ORDINALITY AS u(variant_id, quantity, position)`);
      }
      const after = (await bundlesOfProductsIn(tx, shopId, [productId])).get(productId) ?? null;
      await appendEvent<ProductBundleUpdatedPayload>(tx, shopId, {
        type: BundleEvents.Updated,
        aggregateType: 'product_bundle',
        aggregateId: productId,
        payload: {
          variantIds: [
            ...new Set([...(before?.components.map((part) => part.variantId) ?? []), ...ids]),
          ].sort(),
        },
      });
      return { ok: true, value: after };
    });
  }
}

/**
 * How many of a bundle can be sold: the fewest sets its parts' stock makes, each part's
 * `sellable` (null for no limit) over how many a set holds; null when no part has a limit, and
 * none when it is missing a part (ADR-410).
 */
export function bundleSellable(
  bundle: Pick<BundleRecord, 'complete' | 'components'>,
  sellable: ReadonlyMap<string, number | null>,
): number | null {
  if (!bundle.complete) return 0;
  let fewest: number | null = null;
  for (const part of bundle.components) {
    const left = sellable.get(part.variantId) ?? null;
    if (left === null) continue;
    const sets = Math.floor(Math.max(left, 0) / part.quantity);
    fewest = fewest === null ? sets : Math.min(fewest, sets);
  }
  return fewest;
}

/** The bundles holding a variant of the products among `productIds`, in the caller's `tx`. */
export async function bundlesContainingIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  const { rows } = await tx.execute<{ product_id: string }>(sql`
    SELECT DISTINCT c.product_id FROM catalog.bundle_components c
      JOIN catalog.variants v ON v.shop_id = c.shop_id AND v.id = c.variant_id
     WHERE c.shop_id = ${shopId}
       AND v.product_id = ANY(${sql.param([...productIds])}::uuid[])
     ORDER BY c.product_id`);
  return rows.map((row) => row.product_id);
}

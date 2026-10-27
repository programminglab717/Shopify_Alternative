import { failOne, type FieldError, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { loadProducts } from './product-store.js';
import type { ProductRecord } from './records.js';

// Combined listings (CAT-23, ADR-799): products a shop shows as one listing, each a value of the
// listing's option, as a print's colours often are separate products in Pakistani shops. Each
// product's page offers the others as that option's other values, linking to their pages.

/** Events of the shop's combined listings. */
export const CombinedListingEvents = {
  /** A listing was made, its option or products changed, or it was deleted. */
  Updated: 'combined_listing.updated',
} as const;

/** The products a listing's change touches: those in it before and after, whose pages change. */
export interface CombinedListingUpdatedPayload {
  productIds: string[];
}

/** What a listing holds at least and at most, and how long its words may be. */
export const COMBINED_LISTING_LIMITS = {
  products: { min: 2, max: 100 },
  optionName: 255,
  value: 255,
} as const;

/** A product of a listing: its value of the listing's option. */
export interface CombinedListingProduct {
  productId: string;
  value: string;
}

/** A product of a listing as kept: whether it is on sale, for the storefront to show it. */
export interface CombinedListingMember extends CombinedListingProduct {
  active: boolean;
}

export interface CombinedListingRecord {
  id: string;
  /** What its products differ by: "Colour". */
  optionName: string;
  /** In the order its pages show them. */
  products: CombinedListingMember[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CombinedListingInput {
  optionName: string;
  products: readonly CombinedListingProduct[];
}

type ListingRow = {
  id: string;
  option_name: string;
  created_at: Date;
  updated_at: Date;
  products: CombinedListingMember[];
};

/** The listings `where` picks, each with its products in order, in the caller's transaction. */
async function listingsWhere(tx: Tx, shopId: string, where: SQL): Promise<CombinedListingRecord[]> {
  const { rows } = await tx.execute<ListingRow>(sql`
    SELECT l.id, l.option_name, l.created_at, l.updated_at,
           coalesce((SELECT json_agg(json_build_object('productId', m.product_id, 'value', m.value,
                                                       'active', p.status = 'active')
                                     ORDER BY m.position)
                       FROM catalog.combined_listing_products m
                       JOIN catalog.products p ON p.shop_id = m.shop_id AND p.id = m.product_id
                      WHERE m.shop_id = l.shop_id AND m.listing_id = l.id), '[]') AS products
      FROM catalog.combined_listings l
     WHERE l.shop_id = ${shopId} AND ${where}
     ORDER BY l.created_at DESC, l.id DESC`);
  return rows.map((row) => ({
    id: row.id,
    optionName: row.option_name,
    products: row.products,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }));
}

/**
 * The listing each of `productIds` is in, in the caller's transaction: a product in none has none
 * in the map. Its products are all of the listing's, whatever their status; a storefront shows
 * those it sells.
 */
export async function combinedListingsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, CombinedListingRecord>> {
  if (productIds.length === 0) return new Map();
  const listings = await listingsWhere(
    tx,
    shopId,
    sql`l.id IN (SELECT listing_id FROM catalog.combined_listing_products
                  WHERE shop_id = ${shopId}
                    AND product_id = ANY(${sql.param([...productIds])}::uuid[]))`,
  );
  const asked = new Set(productIds);
  const byProduct = new Map<string, CombinedListingRecord>();
  for (const listing of listings) {
    for (const { productId } of listing.products) {
      if (asked.has(productId)) byProduct.set(productId, listing);
    }
  }
  return byProduct;
}

/** The shop's combined listings: made, changed and deleted through the Admin API. */
@Injectable()
export class CombinedListingService {
  constructor(private readonly db: Database) {}

  /** The shop's listings, the newest first. */
  async list(tenant: TenantContext): Promise<CombinedListingRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => listingsWhere(tx, tenant.shopId, sql`true`));
  }

  async get(tenant: TenantContext, id: string): Promise<CombinedListingRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [listing] = await listingsWhere(tx, tenant.shopId, sql`l.id = ${id}`);
      return listing ?? null;
    });
  }

  /** The listing each of `productIds` is in. */
  async ofProducts(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, CombinedListingRecord>> {
    return this.db.tenant(tenant.shopId, (tx) => combinedListingsIn(tx, tenant.shopId, productIds));
  }

  /** Products by their IDs, whatever their status, for a listing's products to name. */
  async productsOf(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, ProductRecord>> {
    if (productIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const records = await loadProducts(tx, tenant.shopId, {
        where: sql`p.id = ANY(${sql.param([...productIds])}::uuid[])`,
      });
      return new Map(records.map((record) => [record.id, record]));
    });
  }

  /**
   * Makes a listing of `input`'s products, in their order, or, given `id`, sets that listing's
   * option and products in place of those it had: 2 to 100 products, each in no other listing,
   * each with a value of its own, whatever its case.
   */
  async set(
    tenant: TenantContext,
    id: string | null,
    input: CombinedListingInput,
  ): Promise<MutationResult<CombinedListingRecord>> {
    const errors: FieldError[] = [];
    const optionName = input.optionName.trim();
    if (optionName.length < 1 || optionName.length > COMBINED_LISTING_LIMITS.optionName) {
      errors.push({
        field: ['input', 'optionName'],
        code: 'INVALID',
        message: `Give the option's name, up to ${COMBINED_LISTING_LIMITS.optionName} characters`,
      });
    }
    const { min, max } = COMBINED_LISTING_LIMITS.products;
    if (input.products.length < min || input.products.length > max) {
      errors.push({
        field: ['input', 'products'],
        code: input.products.length > max ? 'TOO_MANY' : 'INVALID',
        message: `A combined listing has ${min} to ${max} products`,
      });
    }
    const products = input.products.map((product) => ({
      productId: product.productId,
      value: product.value.trim(),
    }));
    const ids = new Set<string>();
    const values = new Set<string>();
    products.forEach((product, index) => {
      const field = ['input', 'products', String(index)];
      if (ids.has(product.productId)) {
        errors.push({
          field: [...field, 'productId'],
          code: 'TAKEN',
          message: 'This product is named already',
        });
      }
      ids.add(product.productId);
      if (product.value.length < 1 || product.value.length > COMBINED_LISTING_LIMITS.value) {
        errors.push({
          field: [...field, 'value'],
          code: 'INVALID',
          message: `Give its value, up to ${COMBINED_LISTING_LIMITS.value} characters`,
        });
      } else if (values.has(product.value.toLowerCase())) {
        errors.push({
          field: [...field, 'value'],
          code: 'TAKEN',
          message: 'Another product of the listing has this value',
        });
      }
      values.add(product.value.toLowerCase());
    });
    if (errors.length > 0) return { ok: false, errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      let before: string[] = [];
      if (id) {
        const { rows } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM catalog.combined_listings WHERE shop_id = ${shopId} AND id = ${id}
             FOR UPDATE`);
        if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'Combined listing not found');
        const { rows: members } = await tx.execute<{ product_id: string }>(sql`
          SELECT product_id FROM catalog.combined_listing_products
           WHERE shop_id = ${shopId} AND listing_id = ${id}`);
        before = members.map((row) => row.product_id);
      }
      const asked = sql.param(products.map((product) => product.productId));
      const { rows: found } = await tx.execute<{ id: string; listing_id: string | null }>(sql`
        SELECT p.id, m.listing_id
          FROM catalog.products p
          LEFT JOIN catalog.combined_listing_products m
            ON m.shop_id = p.shop_id AND m.product_id = p.id
         WHERE p.shop_id = ${shopId} AND p.id = ANY(${asked}::uuid[])
           FOR UPDATE OF p`);
      const known = new Map(found.map((row) => [row.id, row.listing_id]));
      products.forEach((product, index) => {
        const field = ['input', 'products', String(index), 'productId'];
        const listing = known.get(product.productId);
        if (listing === undefined) {
          errors.push({ field, code: 'NOT_FOUND', message: 'No product of the shop has this ID' });
        } else if (listing !== null && listing !== id) {
          errors.push({
            field,
            code: 'TAKEN',
            message: 'This product is in another combined listing',
          });
        }
      });
      if (errors.length > 0) return { ok: false, errors };

      let listingId = id;
      if (listingId) {
        await tx.execute(sql`
          UPDATE catalog.combined_listings SET option_name = ${optionName}, updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${listingId}`);
        await tx.execute(sql`
          DELETE FROM catalog.combined_listing_products
           WHERE shop_id = ${shopId} AND listing_id = ${listingId}`);
      } else {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO catalog.combined_listings (shop_id, option_name)
          VALUES (${shopId}, ${optionName}) RETURNING id`);
        listingId = rows[0]!.id;
      }
      await tx.execute(sql`
        INSERT INTO catalog.combined_listing_products
               (shop_id, listing_id, product_id, value, position)
        SELECT ${shopId}, ${listingId}, u.product_id, u.value, u.position - 1
          FROM unnest(${asked}::uuid[], ${sql.param(products.map((product) => product.value))}::text[])
               WITH ORDINALITY AS u(product_id, value, position)`);
      await appendEvent<CombinedListingUpdatedPayload>(tx, shopId, {
        type: CombinedListingEvents.Updated,
        aggregateType: 'combined_listing',
        aggregateId: listingId,
        payload: { productIds: [...new Set([...before, ...ids])] },
      });
      const [listing] = await listingsWhere(tx, shopId, sql`l.id = ${listingId}`);
      return { ok: true, value: listing! };
    });
  }

  /** Deletes a listing: its products stay, each shown on its own again. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { shopId } = tenant;
      const { rows: members } = await tx.execute<{ product_id: string }>(sql`
        SELECT product_id FROM catalog.combined_listing_products
         WHERE shop_id = ${shopId} AND listing_id = ${id}`);
      const { rows } = await tx.execute<{ id: string }>(sql`
        DELETE FROM catalog.combined_listings WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING id`);
      if (!rows[0]) return failOne(['id'], 'NOT_FOUND', 'Combined listing not found');
      await appendEvent<CombinedListingUpdatedPayload>(tx, shopId, {
        type: CombinedListingEvents.Updated,
        aggregateType: 'combined_listing',
        aggregateId: id,
        payload: { productIds: members.map((row) => row.product_id) },
      });
      return { ok: true, value: id };
    });
  }
}

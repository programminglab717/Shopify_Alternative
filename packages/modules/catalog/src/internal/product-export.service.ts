import { PublicSite, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { imageAddressOf } from './images.js';
import { failOne, type MutationResult } from './input-checker.js';
import { productSearchConditions } from './product-filter.js';
import { loadProducts } from './product-store.js';
import {
  PRODUCT_IMPORT_LIMITS,
  writeShopifyProducts,
  type ShopifyVariantStock,
} from './shopify-csv.js';

/** What one export holds: a file the import takes back whole (ADR-129). */
export const PRODUCT_EXPORT_LIMITS = {
  rows: PRODUCT_IMPORT_LIMITS.rows,
  csv: PRODUCT_IMPORT_LIMITS.csv,
} as const;

/** What an export wrote. */
export interface ProductExportResult {
  csv: string;
  products: number;
  /** Rows under the headings, as an import counts them. */
  rows: number;
}

/**
 * The stock of tracked variants of `variantIds`, as the inventory module keeps it: the catalog
 * never reads stock, so the caller gives it, as the import hands it the stock to set.
 */
export type ExportStock = (
  variantIds: string[],
) => Promise<ReadonlyMap<string, ShopifyVariantStock>>;

/**
 * Products to Shopify's product CSV (CAT-05, ADR-129): the products a search matches, oldest
 * first, as `writeShopifyProducts` writes them, the catalog's half of an export as
 * `ProductImportService` is of an import. An export is a file the import takes back whole: one
 * that would be more is refused, saying what to narrow.
 */
@Injectable()
export class ProductExportService {
  constructor(
    private readonly db: Database,
    /** Where ready images are served, which the file gives as their Image Src (ADR-158). */
    @Optional() private readonly site?: PublicSite,
  ) {}

  /**
   * The file, with each tracked variant's stock where `stock` is given; without it, none. The
   * rows the products take are counted first, a product taking as many as it has variants or
   * images, whichever is more, and none are read when they are too many.
   */
  async export(
    tenant: TenantContext,
    query: string,
    stock: ExportStock | null,
    limits: { rows?: number; csv?: number } = {},
  ): Promise<MutationResult<ProductExportResult>> {
    const maxRows = limits.rows ?? PRODUCT_EXPORT_LIMITS.rows;
    const maxCharacters = limits.csv ?? PRODUCT_EXPORT_LIMITS.csv;
    const where = sql.join([sql`true`, ...productSearchConditions(query)], sql` AND `);
    const found = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counts } = await tx.execute<{ products: number; rows: number }>(sql`
        SELECT count(*)::int AS products,
               coalesce(sum(greatest(
                 (SELECT count(*) FROM catalog.variants v
                   WHERE v.shop_id = p.shop_id AND v.product_id = p.id),
                 (SELECT count(*) FROM catalog.product_media m
                   WHERE m.shop_id = p.shop_id AND m.product_id = p.id
                     AND m.media_type = 'image'),
                 1)), 0)::int AS rows
          FROM catalog.products p
         WHERE p.shop_id = ${tenant.shopId} AND ${where}`);
      const { products: count, rows } = counts[0]!;
      if (rows > maxRows) return { count, rows, products: null };
      const products =
        count === 0 ? [] : await loadProducts(tx, tenant.shopId, { where, order: sql`p.id` });
      return { count, rows, products };
    });
    if (!found.products) {
      return failOne(
        ['query'],
        'TOO_MANY',
        `The ${found.count.toLocaleString('en')} products that match take ` +
          `${found.rows.toLocaleString('en')} rows; a file holds at most ` +
          `${maxRows.toLocaleString('en')}, as an import takes. ${NARROW}`,
      );
    }
    const variantIds = found.products.flatMap((product) => product.variants.map((v) => v.id));
    const stockOf = stock && variantIds.length > 0 ? await stock(variantIds) : null;
    const file = writeShopifyProducts(found.products, tenant.currency, stockOf, (media, product) =>
      imageAddressOf(this.site, tenant.shopId, media, product.handle),
    );
    if (file.csv.length > maxCharacters) {
      return failOne(
        ['query'],
        'TOO_MANY',
        `The file would be ${file.csv.length.toLocaleString('en')} characters; an import takes ` +
          `at most ${maxCharacters.toLocaleString('en')}. ${NARROW}`,
      );
    }
    return { ok: true, value: { csv: file.csv, products: found.products.length, rows: file.rows } };
  }
}

const NARROW = 'Narrow it down, such as by status, vendor, type or tag, and export the rest apart.';

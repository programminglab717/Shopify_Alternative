import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { failOne, type MutationResult } from './input-checker.js';
import { productSearchConditions } from './product-filter.js';
import { loadProducts } from './product-store.js';
import type { ProductRecord, VariantRecord } from './records.js';
import { PRODUCT_IMPORT_LIMITS, type ShopifyRowProblem } from './shopify-csv.js';
import {
  readShopifyInventory,
  writeShopifyInventory,
  type StockLevel,
} from './shopify-inventory-csv.js';

/** What one stock file holds: as much as one import takes back (ADR-133). */
export const STOCK_FILE_LIMITS = {
  rows: PRODUCT_IMPORT_LIMITS.rows,
  csv: PRODUCT_IMPORT_LIMITS.csv,
} as const;

/**
 * The stock of `variantIds` at each location, as the inventory module keeps it: the catalog never
 * reads stock, so the caller gives it, as for a product export (ADR-129). Variants whose stock is
 * not tracked have none.
 */
export type StockLevels = (
  variantIds: string[],
) => Promise<ReadonlyMap<string, readonly StockLevel[]>>;

/** A row of a stock file, with the variant it names. */
export interface StockCount {
  row: number;
  variantId: string;
  /** "Kurta (M)": the variant, for what is said about the row. */
  name: string;
  /** The location's name, as the file wrote it, for the caller to find. */
  location: string;
  current: number | null;
  quantity: number;
}

/** What a stock file says, read. */
export interface StockFile {
  /** Rows under the headings. */
  rows: number;
  counts: StockCount[];
  /** Rows that change nothing: On hand (new) blank. */
  unchanged: number;
  problems: ShopifyRowProblem[];
}

/**
 * Stock as Shopify's inventory CSV (CAT-05, ADR-133), the catalog's half: the products and
 * variants a file names, by handle and option values, as the catalog keeps them. Their stock is
 * the inventory module's, which the core reads and sets.
 */
@Injectable()
export class StockFileService {
  constructor(private readonly db: Database) {}

  /**
   * The file of the products a search matches, oldest first, a row for each variant at each
   * location `levels` gives it. The variants are counted first, and none read when they are more
   * than a file holds; a file of more rows or characters than an import takes is refused too.
   */
  async export(
    tenant: TenantContext,
    query: string,
    levels: StockLevels,
    limits: { rows?: number; csv?: number } = {},
  ): Promise<MutationResult<{ csv: string; products: number; rows: number }>> {
    const maxRows = limits.rows ?? STOCK_FILE_LIMITS.rows;
    const maxCharacters = limits.csv ?? STOCK_FILE_LIMITS.csv;
    const where = sql.join([sql`true`, ...productSearchConditions(query)], sql` AND `);
    const found = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counts } = await tx.execute<{ products: number; variants: number }>(sql`
        SELECT count(*)::int AS products,
               coalesce(sum((SELECT count(*) FROM catalog.variants v
                              WHERE v.shop_id = p.shop_id AND v.product_id = p.id)), 0)::int
                 AS variants
          FROM catalog.products p
         WHERE p.shop_id = ${tenant.shopId} AND ${where}`);
      const { products: count, variants } = counts[0]!;
      if (variants > maxRows) return { count, variants, products: null };
      const products =
        count === 0 ? [] : await loadProducts(tx, tenant.shopId, { where, order: sql`p.id` });
      return { count, variants, products };
    });
    if (!found.products) {
      return failOne(
        ['query'],
        'TOO_MANY',
        `The ${found.count.toLocaleString('en')} products that match have ` +
          `${found.variants.toLocaleString('en')} variants; a file holds at most ` +
          `${maxRows.toLocaleString('en')} rows, as an import takes. ${NARROW}`,
      );
    }
    const variantIds = found.products.flatMap((product) => product.variants.map((v) => v.id));
    const stock = variantIds.length > 0 ? await levels(variantIds) : new Map();
    const file = writeShopifyInventory(found.products, stock);
    if (file.rows > maxRows || file.csv.length > maxCharacters) {
      return failOne(
        ['query'],
        'TOO_MANY',
        `The file would have ${file.rows.toLocaleString('en')} rows and ` +
          `${file.csv.length.toLocaleString('en')} characters; an import takes at most ` +
          `${maxRows.toLocaleString('en')} rows and ${maxCharacters.toLocaleString('en')} ` +
          `characters. ${NARROW}`,
      );
    }
    return {
      ok: true,
      value: { csv: file.csv, products: found.products.length, rows: file.rows },
    };
  }

  /**
   * The counts of a stock file, each with the variant it names: by its product's handle, and its
   * option values in any letter case, or the product's one variant. What names no variant is
   * said by row, as is what is wrong with a row's cells; the locations are the caller's to find.
   */
  async read(tenant: TenantContext, csv: string): Promise<MutationResult<StockFile>> {
    const file = readShopifyInventory(csv);
    if (!file.ok) return failOne(['csv'], file.code, file.message);
    const handles = [...new Set(file.counts.map((count) => count.handle))];
    const products =
      handles.length === 0
        ? []
        : await this.db.tenant(tenant.shopId, (tx) =>
            loadProducts(tx, tenant.shopId, {
              where: sql`p.handle = ANY(${sql.param(handles)}::text[])`,
            }),
          );
    const byHandle = new Map(products.map((product) => [product.handle, product]));
    const problems = [...file.problems];
    const counts: StockCount[] = [];
    for (const count of file.counts) {
      const product = byHandle.get(count.handle);
      if (!product) {
        problems.push({
          row: count.row,
          column: 'Handle',
          message: `No product has the handle "${count.handle}"`,
        });
        continue;
      }
      const variant = variantOf(product, count.optionValues);
      if (!variant) {
        const values = count.optionValues.filter((value) => value !== '').join(' / ');
        problems.push({
          row: count.row,
          column: 'Option1 Value',
          message: `"${product.title}" has no variant ${values ? `"${values}"` : 'without options'}`,
        });
        continue;
      }
      counts.push({
        row: count.row,
        variantId: variant.id,
        name: product.options.length === 0 ? product.title : `${product.title} (${variant.title})`,
        location: count.location,
        current: count.current,
        quantity: count.quantity,
      });
    }
    problems.sort((a, b) => a.row - b.row);
    return {
      ok: true,
      value: { rows: file.rows, counts, unchanged: file.unchanged, problems },
    };
  }
}

/**
 * The variant whose option values are `values`, in the product's order of options and any letter
 * case; a product without options has one, whatever the file says of it.
 */
function variantOf(product: ProductRecord, values: readonly string[]): VariantRecord | null {
  if (product.options.length === 0) return product.variants[0] ?? null;
  const options = [...product.options].sort((a, b) => a.position - b.position);
  const wanted = options.map((_, index) => (values[index] ?? '').toLowerCase());
  return (
    product.variants.find((variant) =>
      options.every(
        (option, index) =>
          (
            variant.selectedOptions.find((each) => each.optionId === option.id)?.value ?? ''
          ).toLowerCase() === wanted[index],
      ),
    ) ?? null
  );
}

const NARROW =
  'Narrow it down, such as by status, vendor, type or tag, or by location, and export the rest ' +
  'apart.';

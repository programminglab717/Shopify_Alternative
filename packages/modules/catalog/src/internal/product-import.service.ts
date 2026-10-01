import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { failOne, type FieldError, type MutationResult } from './input-checker.js';
import { MediaService } from './media.service.js';
import { ProductService } from './product.service.js';
import { products } from './schema.js';
import {
  PRODUCT_IMPORT_LIMITS,
  readShopifyProducts,
  type ShopifyProduct,
  type ShopifyRowProblem,
} from './shopify-csv.js';

/** Stock Shopify tracked for a variant the import made, for the inventory module to set. */
export interface ImportedStock {
  variantId: string;
  /** The variant's row in the file. */
  row: number;
  quantity: number;
  /** Shopify's inventory policy was continue: sold when out of stock. */
  continueSelling: boolean;
}

/** What an import did, or would do in a dry run. */
export interface ProductImportResult {
  /** Rows under the file's headings. */
  rows: number;
  /** Products made, or that would be. */
  created: number;
  variants: number;
  images: number;
  /** Products left as they are: the shop has products with their handles already. */
  skipped: number;
  /** The first of the rows' problems, in the file's order. */
  rowErrors: ShopifyRowProblem[];
  rowErrorCount: number;
  dryRun: boolean;
  /**
   * Stock for the variants made where Shopify tracked it: the catalog cannot set stock, which is
   * the inventory module's, so the caller sets it.
   */
  stock: ImportedStock[];
}

/** Handles looked up at a time. */
const HANDLE_BATCH = 1_000;

/**
 * Products from a Shopify store's product export (ONB-05): each product the file describes is
 * made as `productCreate` would make it, in a transaction of its own, keeping its handle and so its
 * address, then given its images. A product the shop has a handle for already is left as it is,
 * so the same file can be imported again; one that the catalog cannot take is said by its rows and
 * columns, and the rest go in.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
    private readonly media: MediaService,
  ) {}

  async import(
    tenant: TenantContext,
    csv: string,
    options: { dryRun?: boolean } = {},
  ): Promise<MutationResult<ProductImportResult>> {
    const dryRun = options.dryRun ?? false;
    const file = readShopifyProducts(csv);
    if (!file.ok) return failOne(['csv'], file.code, file.message);
    const problems = [...file.problems];
    const taken = await this.db.tenant(tenant.shopId, (tx) =>
      handlesTaken(
        tx,
        tenant.shopId,
        file.products.map((product) => product.handle),
      ),
    );
    const result = { created: 0, variants: 0, images: 0, skipped: 0 };
    const stock: ImportedStock[] = [];
    for (const product of file.products) {
      if (taken.has(product.handle)) {
        result.skipped++;
        continue;
      }
      const errors = this.products.checkCreate(tenant, product.input);
      if (errors.length > 0) {
        problems.push(...errors.map((error) => located(product, error)));
        continue;
      }
      if (dryRun) {
        result.created++;
        result.variants += product.input.variants?.length ?? 0;
        result.images += product.images.length;
        continue;
      }
      const created = await this.products.create(tenant, product.input);
      if (!created.ok) {
        problems.push(...created.errors.map((error) => located(product, error)));
        continue;
      }
      result.created++;
      result.variants += created.value.variants.length;
      created.value.variants.forEach((variant, index) => {
        const tracked = product.stock[index];
        const row = product.variantRows[index] ?? product.row;
        if (tracked) stock.push({ variantId: variant.id, row, ...tracked });
      });
      if (product.images.length === 0) continue;
      const pictures = await this.media.create(
        tenant,
        created.value.id,
        product.images.map((image) => ({ originalSource: image.src, alt: image.alt })),
      );
      if (pictures.ok) {
        result.images += product.images.length;
      } else {
        problems.push(
          ...pictures.errors.map((error) => ({
            row: product.images[Number(error.field[1])]?.row ?? product.row,
            column: 'Image Src',
            message: error.message,
          })),
        );
      }
    }
    problems.sort((a, b) => a.row - b.row);
    return {
      ok: true,
      value: {
        rows: file.rows,
        ...result,
        rowErrors: problems.slice(0, PRODUCT_IMPORT_LIMITS.rowErrors),
        rowErrorCount: problems.length,
        dryRun,
        stock,
      },
    };
  }
}

/** The handles of `handles` the shop's products have already. */
async function handlesTaken(tx: Tx, shopId: string, handles: string[]): Promise<Set<string>> {
  const taken = new Set<string>();
  for (let start = 0; start < handles.length; start += HANDLE_BATCH) {
    const rows = await tx
      .select({ handle: products.handle })
      .from(products)
      .where(
        and(
          eq(products.shopId, shopId),
          inArray(products.handle, handles.slice(start, start + HANDLE_BATCH)),
        ),
      );
    for (const row of rows) taken.add(row.handle);
  }
  return taken;
}

/** The columns of the product's first row that its fields come from. */
const PRODUCT_COLUMNS: Readonly<Record<string, string>> = {
  title: 'Title',
  handle: 'Handle',
  description: 'Body (HTML)',
  vendor: 'Vendor',
  productType: 'Type',
  tags: 'Tags',
};

/** The columns of a variant's row that its fields come from. */
const VARIANT_COLUMNS: Readonly<Record<string, string>> = {
  price: 'Variant Price',
  compareAtPrice: 'Variant Compare At Price',
  cost: 'Cost per item',
  sku: 'Variant SKU',
  barcode: 'Variant Barcode',
  taxable: 'Variant Taxable',
  weightGrams: 'Variant Grams',
  optionValues: 'Option1 Value',
};

/** What the catalog found wrong with a product, at the row and column of the file it came from. */
function located(product: ShopifyProduct, error: FieldError): ShopifyRowProblem {
  const [, key, index, part] = error.field;
  if (key === 'variants' && index !== undefined) {
    return {
      row: product.variantRows[Number(index)] ?? product.row,
      column: (part !== undefined && VARIANT_COLUMNS[part]) || null,
      message: error.message,
    };
  }
  if (key === 'options' && index !== undefined) {
    const option = Number(index) + 1;
    return {
      row: product.row,
      column: part === 'values' ? `Option${option} Value` : `Option${option} Name`,
      message: error.message,
    };
  }
  return {
    row: product.row,
    column: (key !== undefined && PRODUCT_COLUMNS[key]) || null,
    message: error.message,
  };
}

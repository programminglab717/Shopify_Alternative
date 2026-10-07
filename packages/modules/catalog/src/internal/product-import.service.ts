import { PublicSite, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  InputChecker,
  LIMITS,
  failOne,
  type FieldError,
  type MutationResult,
} from './input-checker.js';
import { imageAddressOf } from './images.js';
import { MediaService } from './media.service.js';
import { ProductService, type UpdateProductInput } from './product.service.js';
import type { ProductRecord } from './records.js';
import { products } from './schema.js';
import {
  PRODUCT_IMPORT_LIMITS,
  readShopifyProducts,
  type ShopifyColumn,
  type ShopifyProduct,
  type ShopifyRowProblem,
} from './shopify-csv.js';
import { checkVariantFields, type VariantFieldsInput } from './variant-input.js';
import {
  VariantService,
  type VariantCreateInput,
  type VariantUpdateInput,
} from './variant.service.js';

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
  /** Products the shop had, updated from the file when told to overwrite, or that would be. */
  updated: number;
  /** Variants made, of new products and new to those updated. */
  variants: number;
  /** Images added. */
  images: number;
  /** Products left as they are: the shop has products with their handles already. */
  skipped: number;
  /** The first of the rows' problems, in the file's order. */
  rowErrors: ShopifyRowProblem[];
  rowErrorCount: number;
  dryRun: boolean;
  /**
   * Stock for the variants made where Shopify tracked it: the catalog cannot set stock, which is
   * the inventory module's, so the caller sets it. Variants the shop had keep theirs.
   */
  stock: ImportedStock[];
}

/** What one import has done so far, shared by the products it makes and updates. */
interface ImportRun {
  dryRun: boolean;
  columns: ReadonlySet<ShopifyColumn>;
  counts: Pick<ProductImportResult, 'created' | 'updated' | 'variants' | 'images' | 'skipped'>;
  problems: ShopifyRowProblem[];
  stock: ImportedStock[];
}

/** Handles looked up at a time. */
const HANDLE_BATCH = 1_000;

/**
 * Products from a Shopify store's product export (ONB-05), or from one of the shop's own exports
 * (CAT-05): each product the file describes is made as `productCreate` would make it, in a
 * transaction of its own, keeping its handle and so its address, then given its images. A product
 * the shop has a handle for already is left as it is, so the same file can be imported again; or,
 * told to overwrite, updated from the file (ADR-130). One that the catalog cannot take is said by
 * its rows and columns, and the rest go in.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
    private readonly media: MediaService,
    private readonly variants: VariantService,
    /** Where ready images are served: an export's Image Src, the same image again (ADR-158). */
    @Optional() private readonly site?: PublicSite,
  ) {}

  async import(
    tenant: TenantContext,
    csv: string,
    options: { dryRun?: boolean; overwrite?: boolean } = {},
  ): Promise<MutationResult<ProductImportResult>> {
    const file = readShopifyProducts(csv);
    if (!file.ok) return failOne(['csv'], file.code, file.message);
    const existing = await this.db.tenant(tenant.shopId, (tx) =>
      productIdsOf(
        tx,
        tenant.shopId,
        file.products.map((product) => product.handle),
      ),
    );
    const run: ImportRun = {
      dryRun: options.dryRun ?? false,
      columns: file.columns,
      counts: { created: 0, updated: 0, variants: 0, images: 0, skipped: 0 },
      problems: [...file.problems],
      stock: [],
    };
    for (const product of file.products) {
      const productId = existing.get(product.handle);
      if (productId === undefined) {
        await this.#create(tenant, product, run);
      } else if (options.overwrite) {
        await this.#update(tenant, productId, product, run);
      } else {
        run.counts.skipped++;
      }
    }
    const problems = run.problems.sort((a, b) => a.row - b.row);
    return {
      ok: true,
      value: {
        rows: file.rows,
        ...run.counts,
        rowErrors: problems.slice(0, PRODUCT_IMPORT_LIMITS.rowErrors),
        rowErrorCount: problems.length,
        dryRun: run.dryRun,
        stock: run.stock,
      },
    };
  }

  /** Makes a product the shop has no handle for. */
  async #create(tenant: TenantContext, product: ShopifyProduct, run: ImportRun): Promise<void> {
    const errors = this.products.checkCreate(tenant, product.input);
    if (errors.length > 0) {
      run.problems.push(...errors.map((error) => located(product, error)));
      return;
    }
    if (run.dryRun) {
      run.counts.created++;
      run.counts.variants += product.input.variants?.length ?? 0;
      run.counts.images += product.images.length;
      return;
    }
    const created = await this.products.create(tenant, product.input);
    if (!created.ok) {
      run.problems.push(...created.errors.map((error) => located(product, error)));
      return;
    }
    run.counts.created++;
    run.counts.variants += created.value.variants.length;
    created.value.variants.forEach((variant, index) => {
      const tracked = product.stock[index];
      const row = product.variantRows[index] ?? product.row;
      if (tracked) run.stock.push({ variantId: variant.id, row, ...tracked });
    });
    run.counts.images += await this.#picture(
      tenant,
      created.value,
      product,
      created.value.variants.map((variant) => variant.id),
      run,
    );
  }

  /**
   * Updates a product the shop has from the file (ADR-130): its fields from the columns the file
   * has, a blank cell clearing an optional one; its variants matched by their option values, the
   * file's fields their own, and the file's other combinations new variants; the images it lacks
   * added. Its options must be the file's, and every change is checked before the first is made.
   * Variants the file leaves out stay, and the shop's variants keep their stock.
   */
  async #update(
    tenant: TenantContext,
    productId: string,
    product: ShopifyProduct,
    run: ImportRun,
  ): Promise<void> {
    const errors = this.products.checkCreate(tenant, product.input);
    if (errors.length > 0) {
      run.problems.push(...errors.map((error) => located(product, error)));
      return;
    }
    const current = await this.products.get(tenant, productId);
    if (!current) {
      run.counts.skipped++;
      return;
    }
    const options = [...current.options].sort((a, b) => a.position - b.position);
    const names = (product.input.options ?? []).map((option) => option.name);
    if (
      names.length !== options.length ||
      names.some((name, at) => name.toLowerCase() !== options[at]!.name.toLowerCase())
    ) {
      const said = (list: string[]) => (list.length > 0 ? list.join(', ') : 'no options');
      run.problems.push({
        row: product.row,
        column: 'Option1 Name',
        message:
          `The shop's product has ${said(options.map((option) => option.name))} and the file ` +
          `${said(names)}: change a product's options in the admin, then import it`,
      });
      return;
    }

    // The shop's variants by their option values, in any letter case.
    const keyOf = (values: readonly string[]) =>
      JSON.stringify(values.map((value) => value.trim().toLowerCase()));
    const byValues = new Map(
      current.variants.map((variant) => [
        keyOf(
          options.map(
            (option) =>
              variant.selectedOptions.find((selected) => selected.optionId === option.id)?.value ??
              '',
          ),
        ),
        variant,
      ]),
    );
    const updates: { index: number; input: VariantUpdateInput }[] = [];
    const creates: { index: number; input: VariantCreateInput }[] = [];
    (product.input.variants ?? []).forEach((variant, index) => {
      const match = byValues.get(keyOf(variant.optionValues ?? []));
      if (match) updates.push({ index, input: { id: match.id, ...variantChanges(variant, run) } });
      else creates.push({ index, input: variant });
    });

    // Every change checked before the first is made, so a product is updated whole or not at all.
    const check = new InputChecker();
    for (const { index, input } of updates) {
      checkVariantFields(check, ['input', 'variants', String(index)], input, tenant.currency, {
        requirePrice: false,
      });
    }
    for (const { index, input } of creates) {
      checkVariantFields(check, ['input', 'variants', String(index)], input, tenant.currency, {
        requirePrice: true,
      });
    }
    if (current.variants.length + creates.length > LIMITS.variants) {
      check.addMessage(
        ['input', 'variants'],
        'TOO_MANY',
        `A product can have at most ${LIMITS.variants} variants`,
      );
    }
    if (!check.ok) {
      run.problems.push(...check.errors.map((error) => located(product, error)));
      return;
    }
    if (run.dryRun) {
      run.counts.updated++;
      run.counts.variants += creates.length;
      const have = this.#imagesOf(tenant, current);
      run.counts.images += product.images.filter((image) => !have.has(image.src)).length;
      return;
    }

    const changed = await this.products.update(tenant, {
      id: productId,
      ...productChanges(product, run),
    });
    if (!changed.ok) {
      run.problems.push(...changed.errors.map((error) => located(product, error)));
      return;
    }
    const variantIds: (string | undefined)[] = [];
    for (const { index, input } of updates) variantIds[index] = input.id;
    if (updates.length > 0) {
      const done = await this.variants.bulkUpdate(
        tenant,
        productId,
        updates.map(({ input }) => input),
      );
      if (!done.ok) {
        run.problems.push(...done.errors.map((error) => locatedIn(product, error, updates)));
        return;
      }
    }
    if (creates.length > 0) {
      const made = await this.variants.bulkCreate(
        tenant,
        productId,
        creates.map(({ input }) => input),
      );
      if (!made.ok) {
        run.problems.push(...made.errors.map((error) => locatedIn(product, error, creates)));
        return;
      }
      run.counts.variants += creates.length;
      creates.forEach(({ index }, at) => {
        const variantId = made.value.variantIds[at]!;
        variantIds[index] = variantId;
        const tracked = product.stock[index];
        const row = product.variantRows[index] ?? product.row;
        if (tracked) run.stock.push({ variantId, row, ...tracked });
      });
    }
    run.counts.updated++;
    const latest = await this.products.get(tenant, productId);
    if (latest) run.counts.images += await this.#picture(tenant, latest, product, variantIds, run);
  }

  /**
   * Gives the product the file's images it lacks, by address, and shows each of the file's
   * variants, `variantIds` in the file's order, with its own image, as Shopify showed it.
   * Returns how many images it added.
   */
  async #picture(
    tenant: TenantContext,
    record: ProductRecord,
    product: ShopifyProduct,
    variantIds: readonly (string | undefined)[],
    run: ImportRun,
  ): Promise<number> {
    const mediaOf = this.#imagesOf(tenant, record);
    const added = product.images.filter((image) => !mediaOf.has(image.src));
    if (added.length > 0) {
      const pictures = await this.media.create(
        tenant,
        record.id,
        added.map((image) => ({ originalSource: image.src, alt: image.alt })),
      );
      if (!pictures.ok) {
        run.problems.push(
          ...pictures.errors.map((error) => ({
            row: added[Number(error.field[1])]?.row ?? product.row,
            column: 'Image Src',
            message: error.message,
          })),
        );
        return 0;
      }
      added.forEach((image, index) => mediaOf.set(image.src, pictures.value.mediaIds[index]!));
    }
    const shown = new Map(record.variants.map((variant) => [variant.id, variant.mediaId]));
    const linked = variantIds.flatMap((variantId, index) => {
      const src = product.variantImages[index];
      const mediaId = src ? mediaOf.get(src) : undefined;
      return variantId && mediaId && shown.get(variantId) !== mediaId
        ? [{ id: variantId, mediaId }]
        : [];
    });
    if (linked.length > 0) {
      const done = await this.variants.bulkUpdate(tenant, record.id, linked);
      if (!done.ok) {
        run.problems.push({
          row: product.row,
          column: 'Variant Image',
          message: done.errors[0]?.message ?? "The variants' images could not be set",
        });
      }
    }
    return added.length;
  }

  /**
   * A product's images by the addresses a file may name them by: where each came from, and where
   * Hatti serves it once ready, as an export gives it (ADR-158).
   */
  #imagesOf(tenant: TenantContext, record: ProductRecord): Map<string, string> {
    const images = new Map<string, string>();
    for (const media of record.media) {
      if (media.mediaType !== 'image') continue;
      images.set(media.sourceUrl, media.id);
      images.set(imageAddressOf(this.site, tenant.shopId, media, record.handle), media.id);
    }
    return images;
  }
}

/**
 * A product's fields from the file's first row of it: those of the columns the file has, so that
 * a column it lacks leaves the product's field as it is.
 */
function productChanges(product: ShopifyProduct, run: ImportRun): Omit<UpdateProductInput, 'id'> {
  const { input } = product;
  const has = (column: ShopifyColumn) => run.columns.has(column);
  return {
    title: input.title,
    ...(has('body') && { description: input.description ?? '' }),
    ...(has('vendor') && { vendor: input.vendor ?? null }),
    ...(has('type') && { productType: input.productType ?? null }),
    ...(has('tags') && { tags: input.tags ?? [] }),
    ...((has('status') || has('published')) && { status: input.status ?? null }),
    ...((has('seoTitle') || has('seoDescription')) && {
      seo: {
        ...(has('seoTitle') && { title: input.seo?.title ?? null }),
        ...(has('seoDescription') && { description: input.seo?.description ?? null }),
      },
    }),
  };
}

/**
 * A variant's fields from its row: those of the columns the file has, a blank cell clearing an
 * optional one, as Shopify's import does; a blank price or weight leaves the variant's.
 */
function variantChanges(variant: VariantFieldsInput, run: ImportRun): VariantFieldsInput {
  const has = (column: ShopifyColumn) => run.columns.has(column);
  return {
    ...(variant.price && { price: variant.price }),
    ...(has('compareAtPrice') && { compareAtPrice: variant.compareAtPrice ?? null }),
    ...(has('cost') && { cost: variant.cost ?? null }),
    ...(has('sku') && { sku: variant.sku ?? null }),
    ...(has('barcode') && { barcode: variant.barcode ?? null }),
    ...(variant.weightGrams !== undefined && { weightGrams: variant.weightGrams }),
    ...(has('taxable') && { taxable: variant.taxable ?? true }),
    ...(has('taxCode') && { taxCode: variant.taxCode ?? null }),
  };
}

/** The shop's products of `handles`, by handle. */
async function productIdsOf(
  tx: Tx,
  shopId: string,
  handles: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < handles.length; start += HANDLE_BATCH) {
    const rows = await tx
      .select({ id: products.id, handle: products.handle })
      .from(products)
      .where(
        and(
          eq(products.shopId, shopId),
          inArray(products.handle, handles.slice(start, start + HANDLE_BATCH)),
        ),
      );
    for (const row of rows) found.set(row.handle, row.id);
  }
  return found;
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
  taxCode: 'Variant Tax Code',
  weightGrams: 'Variant Grams',
  optionValues: 'Option1 Value',
};

/**
 * What a bulk variant change refused, at the row of the file: its `variants` index is the change's
 * among `changes`, which say each one's index among the file's variants.
 */
function locatedIn(
  product: ShopifyProduct,
  error: FieldError,
  changes: readonly { index: number }[],
): ShopifyRowProblem {
  const [key, index, ...rest] = error.field;
  const change = key === 'variants' && index !== undefined ? changes[Number(index)] : undefined;
  return located(product, {
    ...error,
    field: change
      ? ['input', 'variants', String(change.index), ...rest]
      : ['input', ...error.field],
  });
}

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
  if (key === 'seo') {
    return {
      row: product.row,
      column: index === 'description' ? 'SEO Description' : 'SEO Title',
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

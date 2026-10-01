import type { TenantContext } from '@hatti/api';
import { executePrepared, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { searchKey } from '@hatti/pk';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { refreshMemberships } from './collection-store.js';
import { CatalogEvents, type ProductUpdatedPayload } from './events.js';
import type { MediaRecord, OptionRecord, ProductRecord, VariantRecord } from './records.js';
import { products, type ProductRow, type ProductStatusValue } from './schema.js';
import type { OptionShape } from './variant-input.js';

/** Title of the only variant of a product without options, as Shopify names it. */
export const DEFAULT_VARIANT_TITLE = 'Default Title';

interface ProductJsonRow extends Record<string, unknown> {
  id: string;
  title: string;
  handle: string;
  status: ProductStatusValue;
  description: string;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
  options: {
    id: string;
    name: string;
    position: number;
    values: { id: string; name: string; position: number }[];
  }[];
  variants: {
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: string;
    compareAtPrice: string | null;
    cost: string | null;
    weightGrams: number | null;
    taxable: boolean;
    taxCode: string | null;
    position: number;
    optionValueIds: (string | null)[];
    mediaId: string | null;
  }[];
  media: Omit<MediaRecord, 'productId'>[];
}

const toBigInt = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

function toProductRecord(row: ProductJsonRow): ProductRecord {
  const used = new Set(
    row.variants.flatMap((variant) => variant.optionValueIds.filter((id) => id !== null)),
  );
  const options: OptionRecord[] = row.options.map((option) => ({
    id: option.id,
    name: option.name,
    position: option.position,
    values: option.values.map((value) => ({ ...value, hasVariants: used.has(value.id) })),
  }));
  const valueById = new Map(
    options.flatMap((option) => option.values.map((value) => [value.id, { option, value }])),
  );
  const variants: VariantRecord[] = row.variants.map((variant) => ({
    id: variant.id,
    productId: row.id,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    price: BigInt(variant.price),
    compareAtPrice: toBigInt(variant.compareAtPrice),
    cost: toBigInt(variant.cost),
    weightGrams: variant.weightGrams,
    taxable: variant.taxable,
    taxCode: variant.taxCode,
    position: variant.position,
    mediaId: variant.mediaId,
    selectedOptions: variant.optionValueIds.flatMap((id) => {
      const found = id === null ? undefined : valueById.get(id);
      return found
        ? [
            {
              name: found.option.name,
              value: found.value.name,
              optionId: found.option.id,
              valueId: found.value.id,
            },
          ]
        : [];
    }),
  }));
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    status: row.status,
    description: row.description,
    vendor: row.vendor,
    productType: row.product_type,
    tags: row.tags,
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    options,
    variants,
    media: row.media.map((media) => ({ ...media, productId: row.id })),
  };
}

/**
 * Products with their options, variants and media, in one statement: one round trip for a whole
 * page. Spike 5 measured every round trip through PgBouncer, so reads avoid a query per relation.
 * Amounts travel as text: JSON numbers lose precision above 2^53. A prepared statement (ADR-108):
 * newest first, or by ID or handle, its plan is the same for every shop.
 */
export async function loadProducts(
  tx: Tx,
  shopId: string,
  options: { where?: SQL; order?: SQL; limit?: number } = {},
): Promise<ProductRecord[]> {
  return (await queryProducts(tx, shopId, { ...options, prepared: true })).map((row) => row.record);
}

/**
 * Like {@link loadProducts}, and also returns each product's value of `key`, the sort key a page
 * cursor needs (a collection position, a price or a title). Prepared only when `prepared` says
 * so: a collection's pages, sorted by price, position or title, are planned each time.
 */
export async function queryProducts(
  tx: Tx,
  shopId: string,
  options: { where?: SQL; order?: SQL; limit?: number; key?: SQL; prepared?: boolean },
): Promise<{ record: ProductRecord; key: string | null }[]> {
  const query = sql`
    SELECT p.id, p.title, p.handle, p.status, p.description, p.vendor, p.product_type, p.tags,
           p.version, p.created_at, p.updated_at,
           (${options.key ?? sql`NULL`})::text AS sort_key,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', o.id, 'name', o.name, 'position', o.position,
                     'values', (SELECT coalesce(json_agg(json_build_object(
                                         'id', ov.id, 'name', ov.name, 'position', ov.position)
                                         ORDER BY ov.position), '[]'::json)
                                  FROM catalog.product_option_values ov
                                 WHERE ov.shop_id = o.shop_id AND ov.option_id = o.id))
                     ORDER BY o.position), '[]'::json)
              FROM catalog.product_options o
             WHERE o.shop_id = p.shop_id AND o.product_id = p.id) AS options,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', v.id, 'title', v.title, 'sku', v.sku, 'barcode', v.barcode,
                     'price', v.price::text, 'compareAtPrice', v.compare_at_price::text,
                     'cost', v.cost::text, 'weightGrams', v.weight_grams, 'taxable', v.taxable,
                     'taxCode', v.tax_code, 'position', v.position,
                     'optionValueIds',
                       json_build_array(v.option1_value_id, v.option2_value_id, v.option3_value_id),
                     'mediaId', v.media_id)
                     ORDER BY v.position, v.id), '[]'::json)
              FROM catalog.variants v
             WHERE v.shop_id = p.shop_id AND v.product_id = p.id) AS variants,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', m.id, 'mediaType', m.media_type, 'sourceUrl', m.source_url,
                     'alt', m.alt, 'position', m.position, 'status', m.status,
                     'width', m.width, 'height', m.height)
                     ORDER BY m.position), '[]'::json)
              FROM catalog.product_media m
             WHERE m.shop_id = p.shop_id AND m.product_id = p.id) AS media
      FROM catalog.products p
     WHERE p.shop_id = ${shopId} AND ${options.where ?? sql`true`}
     ORDER BY ${options.order ?? sql`p.id DESC`}
     ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}`;
  type Row = ProductJsonRow & { sort_key: string | null };
  const { rows } = options.prepared
    ? await executePrepared<Row>(tx, query)
    : await tx.execute<Row>(query);
  return rows.map((row) => ({ record: toProductRecord(row), key: row.sort_key }));
}

export async function loadProduct(
  tx: Tx,
  shopId: string,
  productId: string,
): Promise<ProductRecord | null> {
  const [record] = await loadProducts(tx, shopId, { where: sql`p.id = ${productId}` });
  return record ?? null;
}

/** Locks the product row for the rest of the transaction, so concurrent edits queue up. */
export async function lockProduct(
  tx: Tx,
  shopId: string,
  productId: string,
): Promise<ProductRow | undefined> {
  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.shopId, shopId), eq(products.id, productId)))
    .for('update');
  return row;
}

/** Search key over the searchable fields; see searchKey() in @hatti/pk. */
export function searchTextOf(fields: {
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
}): string {
  return searchKey([fields.title, fields.vendor, fields.productType, ...fields.tags].join(' '));
}

/**
 * Records a change to a product's options, variants or media: bumps its version, so caches keyed
 * by version miss, records `product.updated`, and brings smart collections up to date.
 */
export async function productChanged(
  tx: Tx,
  tenant: TenantContext,
  productId: string,
  changed: string[],
): Promise<void> {
  const [updated] = await tx
    .update(products)
    .set({ version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(products.shopId, tenant.shopId), eq(products.id, productId)))
    .returning({ version: products.version });
  if (!updated) throw new Error('Product disappeared during update');
  await appendEvent<ProductUpdatedPayload>(tx, tenant.shopId, {
    type: CatalogEvents.ProductUpdated,
    aggregateType: 'product',
    aggregateId: productId,
    payload: { changed, version: updated.version },
  });
  await refreshMemberships(tx, tenant, { productIds: [productId] });
}

/** Variant title from its option values, e.g. "M / Maroon". */
export function variantTitle(valueNames: readonly string[]): string {
  return valueNames.length === 0 ? DEFAULT_VARIANT_TITLE : valueNames.join(' / ');
}

/**
 * Rewrites the titles of a product's variants from their option values, after options or values
 * were renamed, reordered, added or removed. One statement.
 */
export async function retitleVariants(tx: Tx, shopId: string, productId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE catalog.variants v
       SET title = coalesce(
             (SELECT string_agg(ov.name, ' / ' ORDER BY o.position)
                FROM catalog.product_option_values ov
                JOIN catalog.product_options o ON o.shop_id = ov.shop_id AND o.id = ov.option_id
               WHERE ov.shop_id = v.shop_id
                 AND ov.id IN (v.option1_value_id, v.option2_value_id, v.option3_value_id)),
             ${DEFAULT_VARIANT_TITLE}),
           updated_at = now()
     WHERE v.shop_id = ${shopId} AND v.product_id = ${productId}`);
}

/** Options as names and value names, for the input checks. */
export function optionShapes(record: ProductRecord): OptionShape[] {
  return record.options.map((option) => ({
    name: option.name,
    values: option.values.map((value) => value.name),
  }));
}

/**
 * Loads a product for a change: locks its row, so concurrent changes to the same product queue,
 * then reads it whole in one statement.
 */
export async function loadForUpdate(
  tx: Tx,
  shopId: string,
  productId: string,
): Promise<ProductRecord | null> {
  if (!(await lockProduct(tx, shopId, productId))) return null;
  return loadProduct(tx, shopId, productId);
}

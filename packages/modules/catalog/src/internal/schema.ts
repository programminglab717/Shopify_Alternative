// Drizzle mirror of the catalog tables. The SQL migrations in db/migrations are the source of
// truth; product.service.test.ts checks this file against the migrated database.
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const catalogSchema = pgSchema('catalog');

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

export const MEDIA_STATUSES = ['uploaded', 'processing', 'ready', 'failed'] as const;
export type MediaStatusValue = (typeof MEDIA_STATUSES)[number];

/** A ready image's clean copy (ADR-158): JPEG, or PNG for one some of which is see-through. */
export const IMAGE_FORMATS = ['jpeg', 'png'] as const;
export type ImageFormatValue = (typeof IMAGE_FORMATS)[number];

export const COLLECTION_SORT_ORDERS = [
  'manual',
  'alpha_asc',
  'alpha_desc',
  'price_asc',
  'price_desc',
  'created',
  'created_desc',
] as const;
export type CollectionSortOrderValue = (typeof COLLECTION_SORT_ORDERS)[number];

/** One condition of a smart collection, stored as JSON. See collection-rules.ts. */
export interface CollectionRuleValue {
  column: string;
  relation: string;
  condition: string;
}

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const products = catalogSchema.table(
  'products',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    title: text('title').notNull(),
    handle: text('handle').notNull(),
    status: text('status', { enum: PRODUCT_STATUSES }).notNull().default('draft'),
    description: text('description').notNull().default(''),
    vendor: text('vendor'),
    productType: text('product_type'),
    tags: text('tags').array().notNull().default([]),
    /** For search engines and link previews, in place of its own (ADR-231); null for its own. */
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    searchText: text('search_text').notNull().default(''),
    /** The words of what the shop wrote in Urdu for it, folded as `searchText` (ADR-240). */
    translatedText: text('translated_text').notNull().default(''),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('products_shop_handle_key').on(table.shopId, table.handle),
  ],
);

export const productOptions = catalogSchema.table(
  'product_options',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    productId: uuid('product_id').notNull(),
    name: text('name').notNull(),
    position: smallint('position').notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const productOptionValues = catalogSchema.table(
  'product_option_values',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    productId: uuid('product_id').notNull(),
    optionId: uuid('option_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const productMedia = catalogSchema.table(
  'product_media',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    productId: uuid('product_id').notNull(),
    mediaType: text('media_type', { enum: ['image'] })
      .notNull()
      .default('image'),
    sourceUrl: text('source_url').notNull(),
    alt: text('alt').notNull().default(''),
    position: integer('position').notNull(),
    status: text('status', { enum: MEDIA_STATUSES }).notNull().default('uploaded'),
    width: integer('width'),
    height: integer('height'),
    sourceKey: text('source_key'),
    imageFormat: text('image_format', { enum: IMAGE_FORMATS }),
    imageSize: integer('image_size'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const variants = catalogSchema.table(
  'variants',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    productId: uuid('product_id').notNull(),
    title: text('title').notNull().default('Default'),
    sku: text('sku'),
    barcode: text('barcode'),
    price: bigint('price', { mode: 'bigint' }).notNull(),
    compareAtPrice: bigint('compare_at_price', { mode: 'bigint' }),
    cost: bigint('cost', { mode: 'bigint' }),
    weightGrams: integer('weight_grams'),
    /** Whether its price includes the shop's sales tax (TAX-01), as Shopify's "Charge tax". */
    taxable: boolean('taxable').notNull().default(true),
    /** Shopify's tax code: the shop's tax category its price's tax is at (ADR-097), if any. */
    taxCode: text('tax_code'),
    position: integer('position').notNull().default(1),
    option1ValueId: uuid('option1_value_id'),
    option2ValueId: uuid('option2_value_id'),
    option3ValueId: uuid('option3_value_id'),
    mediaId: uuid('media_id'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    foreignKey({
      columns: [table.shopId, table.productId],
      foreignColumns: [products.shopId, products.id],
    }).onDelete('cascade'),
  ],
);

export const collections = catalogSchema.table(
  'collections',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    title: text('title').notNull(),
    handle: text('handle').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: text('sort_order', { enum: COLLECTION_SORT_ORDERS }).notNull().default('manual'),
    rules: jsonb('rules').$type<CollectionRuleValue[] | null>(),
    disjunctive: boolean('disjunctive').notNull().default(false),
    /** For search engines and link previews, in place of its own (ADR-231); null for its own. */
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    searchText: text('search_text').notNull().default(''),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('collections_shop_handle_key').on(table.shopId, table.handle),
  ],
);

export const collectionProducts = catalogSchema.table(
  'collection_products',
  {
    shopId: uuid('shop_id').notNull(),
    collectionId: uuid('collection_id').notNull(),
    productId: uuid('product_id').notNull(),
    position: integer('position').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.collectionId, table.productId] })],
);

export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
export type ProductOptionRow = typeof productOptions.$inferSelect;
export type ProductOptionValueRow = typeof productOptionValues.$inferSelect;
export type ProductMediaRow = typeof productMedia.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;

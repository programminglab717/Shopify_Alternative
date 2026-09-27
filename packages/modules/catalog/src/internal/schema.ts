// Drizzle mirror of the catalog tables. The SQL migrations in db/migrations are the source of
// truth; schema.test.ts checks this file against the migrated database.
import {
  bigint,
  foreignKey,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const catalogSchema = pgSchema('catalog');

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

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
    searchText: text('search_text').notNull().default(''),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('products_shop_handle_key').on(table.shopId, table.handle),
  ],
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
    position: integer('position').notNull().default(1),
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

export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;

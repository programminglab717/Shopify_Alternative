// Drizzle mirror of the online store's tables. The SQL migrations in db/migrations are the source
// of truth; themes.test.ts checks this file against the migrated database.
import {
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { MenuItemValue } from './records.js';

export const onlineStoreSchema = pgSchema('online_store');

export const THEME_ROLES = ['main', 'unpublished'] as const;
export type ThemeRoleValue = (typeof THEME_ROLES)[number];

export const themes = onlineStoreSchema.table(
  'themes',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    base: text('base').notNull(),
    role: text('role').$type<ThemeRoleValue>().notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type ThemeRow = typeof themes.$inferSelect;

export const themeFiles = onlineStoreSchema.table(
  'theme_files',
  {
    shopId: uuid('shop_id').notNull(),
    themeId: uuid('theme_id').notNull(),
    filename: text('filename').notNull(),
    body: text('body').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.themeId, table.filename] })],
);

export type ThemeFileRow = typeof themeFiles.$inferSelect;

export const menus = onlineStoreSchema.table(
  'menus',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    handle: text('handle').notNull(),
    title: text('title').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    items: jsonb('items').$type<MenuItemValue[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('menus_shop_id_handle_key').on(table.shopId, table.handle),
  ],
);

export type MenuRow = typeof menus.$inferSelect;

export const pages = onlineStoreSchema.table(
  'pages',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    handle: text('handle').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    templateSuffix: text('template_suffix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('pages_shop_id_handle_key').on(table.shopId, table.handle),
  ],
);

export type PageRow = typeof pages.$inferSelect;

export const preferences = onlineStoreSchema.table('preferences', {
  shopId: uuid('shop_id').primaryKey(),
  whatsapp: text('whatsapp'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

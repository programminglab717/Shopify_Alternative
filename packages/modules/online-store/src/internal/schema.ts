// Drizzle mirror of the online store's tables. The SQL migrations in db/migrations are the source
// of truth; themes.test.ts checks this file against the migrated database.
import { integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

// Drizzle mirror of the files module's table. The SQL migrations in db/migrations are the source
// of truth; files.test.ts checks this file against the migrated database.
import { integer, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const filesSchema = pgSchema('files');

/** Staged until its upload is in and checked; then ready. */
export const FILE_STATUSES = ['staged', 'ready'] as const;
export type FileStatusValue = (typeof FILE_STATUSES)[number];

export const files = filesSchema.table(
  'files',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    /** Where storage keeps it: shops/{shopId}/files/{id}/{name}. */
    key: text('key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    /** Bytes. */
    size: integer('size').notNull(),
    alt: text('alt').notNull().default(''),
    status: text('status', { enum: FILE_STATUSES }).notNull().default('staged'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique('files_key_key').on(table.shopId, table.key),
  ],
);

export type FileRow = typeof files.$inferSelect;

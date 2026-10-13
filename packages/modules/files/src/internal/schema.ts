// Drizzle mirror of the files module's tables. The SQL migrations in db/migrations are the source
// of truth; files.test.ts checks this file against the migrated database.
import {
  bigint,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** What a shop's brand is made of (ADR-081): its logo, one of its files, an image. */
export const brands = filesSchema.table('brands', {
  shopId: uuid('shop_id').primaryKey(),
  /** Null once there is none, as when its file was deleted. */
  logoFileId: uuid('logo_file_id'),
  /** Its square logo (ADR-205): null once there is none, as the logo. */
  squareLogoFileId: uuid('square_logo_file_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Made once ready; expired once storage let it go (ADR-415). */
export const STORE_EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type StoreExportStatusValue = (typeof STORE_EXPORT_STATUSES)[number];

/** A whole store exported (ADM-10, ADR-415): asked for by an owner, made by a worker. */
export const storeExports = filesSchema.table(
  'store_exports',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    status: text('status', { enum: STORE_EXPORT_STATUSES }).notNull().default('pending'),
    /** Where storage keeps the ZIP while ready: shops/{shopId}/exports/{id}.zip. */
    key: text('key'),
    /** Bytes of the ZIP. */
    size: bigint('size', { mode: 'number' }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type StoreExportRow = typeof storeExports.$inferSelect;

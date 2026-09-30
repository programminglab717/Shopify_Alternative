// Drizzle mirror of the checkout module's tables. The SQL migrations in db/migrations are the
// source of truth; carts.test.ts checks this file against the migrated database.
import {
  customType,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { StoredLine } from './cart-lines.js';

export const checkoutSchema = pgSchema('checkout');

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const carts = checkoutSchema.table(
  'carts',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    lines: jsonb('lines').$type<StoredLine[]>().notNull().default([]),
    note: text('note').notNull().default(''),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique().on(table.shopId, table.tokenHash),
  ],
);

export type CartRow = typeof carts.$inferSelect;

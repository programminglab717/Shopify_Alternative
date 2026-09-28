// Drizzle mirror of the customers tables. The SQL migrations in db/migrations are the source of
// truth; customers.test.ts checks this file against the migrated database.
import { integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const customersSchema = pgSchema('customers');

/** Why a number is on the blocklist. */
export const BLOCK_REASONS = [
  'fake_orders',
  'refused_deliveries',
  'abuse',
  'fraud',
  'other',
] as const;
export type BlockReasonValue = (typeof BLOCK_REASONS)[number];

/** Who blocked a number: an app's access token or a staff member. */
export const BLOCKER_KINDS = ['app', 'staff'] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const customers = customersSchema.table(
  'customers',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    phone: text('phone').notNull(),
    name: text('name'),
    email: text('email'),
    note: text('note').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    searchText: text('search_text').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type CustomerRow = typeof customers.$inferSelect;

export const blocklistEntries = customersSchema.table(
  'blocklist_entries',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    phone: text('phone').notNull(),
    reason: text('reason', { enum: BLOCK_REASONS }).notNull(),
    note: text('note').notNull().default(''),
    actorKind: text('actor_kind', { enum: BLOCKER_KINDS }).notNull(),
    actorId: uuid('actor_id').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type BlocklistEntryRow = typeof blocklistEntries.$inferSelect;

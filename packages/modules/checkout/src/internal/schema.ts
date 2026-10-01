// Drizzle mirror of the checkout module's tables. The SQL migrations in db/migrations are the
// source of truth; carts.test.ts checks this file against the migrated database.
import {
  bigint,
  customType,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
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
    /** The discount code the shopper applied, as the shop wrote it; one at most for now. */
    discountCodes: text('discount_codes').array().notNull().default([]),
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

export const checkouts = checkoutSchema.table(
  'checkouts',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    cartId: uuid('cart_id'),
    orderId: uuid('order_id'),
    /** Codes its page was given that took nothing off. */
    discountAttempts: smallint('discount_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type CheckoutRow = typeof checkouts.$inferSelect;

/** A delivery zone as kept: its charge in minor units, as text, since JSON has no bigint. */
export interface StoredZone {
  name: string;
  cities: string[];
  charge: string;
}

export const deliverySettings = checkoutSchema.table('delivery_settings', {
  shopId: uuid('shop_id').primaryKey(),
  charge: bigint('charge', { mode: 'bigint' }).notNull().default(0n),
  freeAbove: bigint('free_above', { mode: 'bigint' }),
  zones: jsonb('zones').$type<StoredZone[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The shop's rules for cash on delivery at checkout (CHK-07): a total of its own, cities without
 * it, and how many refused parcels a customer may have had; and its fee for it (CHK-08). Shops
 * without a row have none.
 */
export const codSettings = checkoutSchema.table('cod_settings', {
  shopId: uuid('shop_id').primaryKey(),
  maxTotal: bigint('max_total', { mode: 'bigint' }),
  unavailableCities: text('unavailable_cities').array().notNull().default([]),
  /** Products tagged with any of these, in any letter case, are paid another way (ADR-078). */
  unavailableProductTags: text('unavailable_product_tags').array().notNull().default([]),
  refusalsLimit: smallint('refusals_limit'),
  /** What orders paid on delivery are charged for it (CHK-08); 0 for nothing. */
  fee: bigint('fee', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

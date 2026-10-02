// Drizzle mirror of the checkout module's tables. The SQL migrations in db/migrations are the
// source of truth; carts.test.ts checks this file against the migrated database.
import {
  bigint,
  boolean,
  customType,
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
import type { AttributionValue } from '@hatti/orders/public';
import type { StoredLine } from './cart-lines.js';
import type { CodAdvanceValue } from './cod-rules.js';
import type { TrustBadgeValue } from './trust-badges.js';

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
    /**
     * Where the shopper came to the online store from, as the storefront passed it when they
     * began (ADR-139), for the order placed; null when it knew no visit.
     */
    attribution: jsonb('attribution').$type<AttributionValue>(),
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
 * it, how many refused parcels a customer may have had and how high an order's risk may be; its
 * fee for it (CHK-08); and what it asks for in advance (CHK-10). Shops without a row have none.
 */
export const codSettings = checkoutSchema.table('cod_settings', {
  shopId: uuid('shop_id').primaryKey(),
  maxTotal: bigint('max_total', { mode: 'bigint' }),
  unavailableCities: text('unavailable_cities').array().notNull().default([]),
  /** Products tagged with any of these, in any letter case, are paid another way (ADR-078). */
  unavailableProductTags: text('unavailable_product_tags').array().notNull().default([]),
  refusalsLimit: smallint('refusals_limit'),
  /** Orders whose risk score, 1 to 100, is this or more are paid another way (ADR-099). */
  riskLimit: smallint('risk_limit'),
  /** Orders whose risk score, 0 to 100, is this or more ask for a code first (ADR-148). */
  verifyFrom: smallint('verify_from'),
  /** What orders paid on delivery are charged for it (CHK-08); 0 for nothing. */
  fee: bigint('fee', { mode: 'bigint' }).notNull().default(0n),
  /**
   * What checkout asks for in advance on them, by transfer (ADR-084): 'fixed_amount',
   * 'percentage' or 'delivery'; null for no advance.
   */
  advanceKind: text('advance_kind').$type<CodAdvanceValue['kind']>(),
  /** For an amount. */
  advanceAmount: bigint('advance_amount', { mode: 'bigint' }),
  /** For a percentage of the items after any code, in hundredths of a percent: 2000 is 20%. */
  advanceBps: integer('advance_bps'),
  /** Only on orders whose items come to more than this; null for every order. */
  advanceAbove: bigint('advance_above', { mode: 'bigint' }),
  /** Only on orders to these cities, as addresses name them (ADR-089); empty for everywhere. */
  advanceCities: text('advance_cities').array().notNull().default([]),
  /** Only of customers who refused this many parcels before, or more; null for every customer. */
  advanceRefused: smallint('advance_refused'),
  /** Only of customers none of whose orders the shop delivered before (ADR-094). */
  advanceNewCustomers: boolean('advance_new_customers').notNull().default(false),
  /** Only of orders whose risk score, 1 to 100, is this or more; null for every order. */
  advanceRisk: smallint('advance_risk'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The badges the shop chose for its checkout's page (CHK-14, ADR-086), in its order. Shops
 * without a row show none.
 */
export const trustBadges = checkoutSchema.table('trust_badges', {
  shopId: uuid('shop_id').primaryKey(),
  badges: jsonb('badges').$type<TrustBadgeValue[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

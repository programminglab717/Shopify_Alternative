// Drizzle mirror of the pricing module's tables. The SQL migrations in db/migrations are the
// source of truth; discount-codes.test.ts checks this file against the migrated database.
import {
  bigint,
  boolean,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const pricingSchema = pgSchema('pricing');

/**
 * What a code takes off: a share of the items, an amount off them, the delivery charge, or some
 * items for every so many bought (ADR-519).
 */
export const DISCOUNT_KINDS = [
  'percentage',
  'fixed_amount',
  'free_shipping',
  'buy_x_get_y',
] as const;
export type DiscountKindValue = (typeof DISCOUNT_KINDS)[number];

const money = (name: string) => bigint(name, { mode: 'bigint' });

export const discountCodes = pricingSchema.table(
  'discount_codes',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    kind: text('kind', { enum: DISCOUNT_KINDS }).notNull(),
    /** Hundredths of a percent: 1050 is 10.5%. */
    percentageBps: integer('percentage_bps'),
    amount: money('amount'),
    minimumSubtotal: money('minimum_subtotal'),
    /** Buy X get Y (ADR-519): items bought for each group, and items given in it. */
    buyQuantity: integer('buy_quantity'),
    getQuantity: integer('get_quantity'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    usageLimit: integer('usage_limit'),
    oncePerCustomer: boolean('once_per_customer').notNull().default(false),
    used: integer('used').notNull().default(0),
    /** The catalog's products and collections it is for (ADR-517); neither, the whole order. */
    productIds: uuid('product_ids').array().notNull().default([]),
    collectionIds: uuid('collection_ids').array().notNull().default([]),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type DiscountCodeRow = typeof discountCodes.$inferSelect;

/** Each order placed with a code, with its customer, as the code's uses are counted. */
export const discountRedemptions = pricingSchema.table(
  'discount_redemptions',
  {
    shopId: uuid('shop_id').notNull(),
    codeId: uuid('code_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    amount: money('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.codeId, table.orderId] })],
);

/** Discounts given without a code, to every order that qualifies while they run (ADR-515). */
export const automaticDiscounts = pricingSchema.table(
  'automatic_discounts',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    title: text('title').notNull(),
    kind: text('kind', { enum: DISCOUNT_KINDS }).notNull(),
    /** Hundredths of a percent: 1050 is 10.5%. */
    percentageBps: integer('percentage_bps'),
    amount: money('amount'),
    minimumSubtotal: money('minimum_subtotal'),
    /** Buy X get Y (ADR-519): items bought for each group, and items given in it. */
    buyQuantity: integer('buy_quantity'),
    getQuantity: integer('get_quantity'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    combinesWithCodes: boolean('combines_with_codes').notNull().default(false),
    productIds: uuid('product_ids').array().notNull().default([]),
    collectionIds: uuid('collection_ids').array().notNull().default([]),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type AutomaticDiscountRow = typeof automaticDiscounts.$inferSelect;

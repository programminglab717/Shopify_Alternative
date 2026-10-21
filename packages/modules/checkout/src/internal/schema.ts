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
import type { MarketingChannelValue } from '@hatti/customers/public';
import type { AttributionValue } from '@hatti/orders/public';
import type { StoredLine } from './cart-lines.js';
import type { ContactLineValue } from './abandoned.js';
import type { CodAdvanceValue } from './cod-rules.js';
import type { PaymentLinkItemValue } from './payment-links.js';
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
    /** The gift card the shopper applied on the page (ADR-449); null for none. */
    giftCardId: uuid('gift_card_id'),
    /** Codes given on the page that were no card's (ADR-449). */
    giftCardAttempts: smallint('gift_card_attempts').notNull().default(0),
    /**
     * Where the shopper came to the online store from, as the storefront passed it when they
     * began (ADR-139), for the order placed; null when it knew no visit.
     */
    attribution: jsonb('attribution').$type<AttributionValue>(),
    /** The payment link it was opened from (ADR-248), whose rules it keeps; null for a cart's. */
    paymentLinkId: uuid('payment_link_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The name and number the shopper typed, and when, for the shop to remind them (CHK-12). */
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    contactAt: timestamp('contact_at', { withTimezone: true }),
    /** The items, and their subtotal, as the cart held them then. */
    contactLines: jsonb('contact_lines').$type<ContactLineValue[]>(),
    contactSubtotal: bigint('contact_subtotal', { mode: 'bigint' }),
    /** Kept past `expiresAt` until then, as an abandoned checkout with a number is. */
    keptUntil: timestamp('kept_until', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    reminderTokenHash: bytea('reminder_token_hash'),
    /** The order the same number placed after the reminder (ADR-393). */
    recoveredOrderId: uuid('recovered_order_id'),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type CheckoutRow = typeof checkouts.$inferSelect;

/**
 * A link many customers open, each to a checkout of their own with its items (PAY-04, ADR-248).
 */
export const paymentLinks = checkoutSchema.table(
  'payment_links',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    /** In its address, /pay/<token>; kept as it is, since the shop copies it again. */
    token: text('token').notNull(),
    title: text('title').notNull(),
    items: jsonb('items').$type<PaymentLinkItemValue[]>().notNull(),
    discountCode: text('discount_code'),
    prepaidOnly: boolean('prepaid_only').notNull().default(false),
    usageLimit: integer('usage_limit'),
    ordersPlaced: integer('orders_placed').notNull().default(0),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique().on(table.shopId, table.token),
  ],
);

export type PaymentLinkRow = typeof paymentLinks.$inferSelect;

/** A delivery zone as kept: its charge in minor units, as text, since JSON has no bigint. */
export interface StoredZone {
  name: string;
  cities: string[];
  charge: string;
  /** Its own working days (ADR-235); absent in zones saved before, as null. */
  days?: { min: number; max: number } | null;
}

/** What an order over a weight costs more to deliver, as kept: its charge as text. */
export interface StoredWeight {
  aboveGrams: number;
  charge: string;
}

export const deliverySettings = checkoutSchema.table('delivery_settings', {
  shopId: uuid('shop_id').primaryKey(),
  charge: bigint('charge', { mode: 'bigint' }).notNull().default(0n),
  freeAbove: bigint('free_above', { mode: 'bigint' }),
  minDays: smallint('min_days'),
  maxDays: smallint('max_days'),
  /** The hour, in Pakistan's time, from which orders count from the next day (ADR-597). */
  cutoffHour: smallint('cutoff_hour'),
  zones: jsonb('zones').$type<StoredZone[]>().notNull().default([]),
  /** What heavier orders cost more (ADR-702), the lightest first. */
  weights: jsonb('weights').$type<StoredWeight[]>().notNull().default([]),
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
  /** Only on orders holding a product tagged with any of these, in any letter case (ADR-224). */
  advanceProductTags: text('advance_product_tags').array().notNull().default([]),
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

/**
 * The channels the shop's checkout offers boxes for its news and offers on (CUS-04, ADR-187), in
 * the page's order. Shops without a row offer WhatsApp alone.
 */
export const marketingOptions = checkoutSchema.table('marketing_options', {
  shopId: uuid('shop_id').primaryKey(),
  channels: text('channels').array().$type<MarketingChannelValue[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Whether, and how long after a shopper leaves checkout, the shop reminds them (CHK-12). */
export const recoverySettings = checkoutSchema.table('recovery_settings', {
  shopId: uuid('shop_id').primaryKey(),
  reminderAfterMinutes: integer('reminder_after_minutes'),
  offerCodeId: uuid('offer_code_id'),
  offerAfterHours: integer('offer_after_hours'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the shop offers to send a gift with (CHK-16, ADR-413): one of its variants as gift wrap,
 * which checkout adds to the cart when asked, and whether it asks for a gift message. Shops
 * without a row offer neither.
 */
export const giftOptions = checkoutSchema.table('gift_options', {
  shopId: uuid('shop_id').primaryKey(),
  wrapVariantId: uuid('wrap_variant_id'),
  messages: boolean('messages').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

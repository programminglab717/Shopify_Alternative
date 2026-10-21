// Drizzle mirror of the marketing module's tables. The SQL migrations in db/migrations are the
// source of truth; marketing.test.ts checks this file against the migrated database.
import {
  boolean,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { CONVERSION_MOMENTS, CONVERSION_PLATFORMS, CONVERSION_STATUSES } from './meta.js';

export const marketingSchema = pgSchema('marketing');

/** The shop's Meta dataset, and the access token Events Manager gave it (ADR-143). */
export const metaSettings = marketingSchema.table('meta_settings', {
  shopId: uuid('shop_id').primaryKey(),
  pixelId: text('pixel_id').notNull(),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token'),
  /** Its last four characters; null with the pixel alone (ADR-531). */
  tokenHint: text('token_hint'),
  testEventCode: text('test_event_code'),
  /** Which of an order's moments is Meta's Purchase. */
  purchaseAt: text('purchase_at', { enum: CONVERSION_MOMENTS }).notNull().default('placed'),
  /** Whether orders its staff take go to Meta too (ADR-655). */
  staffOrders: boolean('staff_orders').notNull().default(false),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's TikTok pixel, and the access token Events Manager gave it (ADR-541). */
export const tiktokSettings = marketingSchema.table('tiktok_settings', {
  shopId: uuid('shop_id').primaryKey(),
  pixelCode: text('pixel_code').notNull(),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  /** Its last four characters. */
  tokenHint: text('token_hint').notNull(),
  testEventCode: text('test_event_code'),
  /** Which of an order's moments is TikTok's purchase. */
  purchaseAt: text('purchase_at', { enum: CONVERSION_MOMENTS }).notNull().default('placed'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's Google Analytics web stream, and the API secret made for it (ADR-547). */
export const googleSettings = marketingSchema.table('google_settings', {
  shopId: uuid('shop_id').primaryKey(),
  measurementId: text('measurement_id').notNull(),
  /** Sealed for the shop alone, and never shown again. */
  apiSecret: text('api_secret').notNull(),
  /** Its last four characters. */
  secretHint: text('secret_hint').notNull(),
  /** Which of an order's moments is Google's purchase. */
  purchaseAt: text('purchase_at', { enum: CONVERSION_MOMENTS }).notNull().default('placed'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's Meta ad account, whose spend is pulled from Meta's Marketing API (ADR-564). */
export const metaAdAccounts = marketingSchema.table('meta_ad_accounts', {
  shopId: uuid('shop_id').primaryKey(),
  /** Its digits, without "act_". */
  adAccountId: text('ad_account_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  /** The time zone Meta reports its days in. */
  timezone: text('timezone'),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  /** Its last four characters. */
  tokenHint: text('token_hint').notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  /** Why the last pull failed. */
  lastError: text('last_error'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's TikTok advertiser account, whose spend is pulled from TikTok (ADR-566). */
export const tiktokAdAccounts = marketingSchema.table('tiktok_ad_accounts', {
  shopId: uuid('shop_id').primaryKey(),
  /** Its digits, as TikTok Ads Manager shows them. */
  advertiserId: text('advertiser_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  /** The time zone TikTok reports its days in. */
  timezone: text('timezone'),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  /** Its last four characters. */
  tokenHint: text('token_hint').notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  /** Why the last pull failed. */
  lastError: text('last_error'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's Google Ads account, whose spend is pulled from the Google Ads API (ADR-678). */
export const googleAdsAccounts = marketingSchema.table('google_ads_accounts', {
  shopId: uuid('shop_id').primaryKey(),
  /** Its ten digits, as Google Ads shows them without their dashes. */
  customerId: text('customer_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  /** The time zone Google reports its days in. */
  timezone: text('timezone'),
  /** The grant's refresh token, sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  /** Its last four characters. */
  tokenHint: text('token_hint').notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  /** Why the last pull failed. */
  lastError: text('last_error'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Each moment of an order to send to an ad platform, and how sending it went. */
export const conversions = marketingSchema.table(
  'conversions',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    platform: text('platform', { enum: CONVERSION_PLATFORMS }).notNull(),
    orderId: uuid('order_id').notNull(),
    moment: text('moment', { enum: CONVERSION_MOMENTS }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: CONVERSION_STATUSES }).notNull().default('pending'),
    /** The name it went by once sent. */
    eventName: text('event_name'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** What the platform said last: why it refused it. */
    error: text('error'),
    /** The trace of the request that took it, or refused it, to ask the platform about. */
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.id] }),
    unique().on(table.shopId, table.platform, table.orderId, table.moment),
  ],
);

export type ConversionRow = typeof conversions.$inferSelect;

// Drizzle mirror of the marketing module's tables. The SQL migrations in db/migrations are the
// source of truth; marketing.test.ts checks this file against the migrated database.
import { integer, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CONVERSION_MOMENTS, CONVERSION_PLATFORMS, CONVERSION_STATUSES } from './meta.js';

export const marketingSchema = pgSchema('marketing');

/** The shop's Meta dataset, and the access token Events Manager gave it (ADR-143). */
export const metaSettings = marketingSchema.table('meta_settings', {
  shopId: uuid('shop_id').primaryKey(),
  pixelId: text('pixel_id').notNull(),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  /** Its last four characters. */
  tokenHint: text('token_hint').notNull(),
  testEventCode: text('test_event_code'),
  /** Which of an order's moments is Meta's Purchase. */
  purchaseAt: text('purchase_at', { enum: CONVERSION_MOMENTS }).notNull().default('placed'),
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

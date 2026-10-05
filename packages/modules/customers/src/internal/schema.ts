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

/** Channels marketing can go out on, each with its own consent. */
export const MARKETING_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type MarketingChannelValue = (typeof MARKETING_CHANNELS)[number];

export const MARKETING_STATES = ['not_subscribed', 'subscribed', 'unsubscribed'] as const;
export type MarketingStateValue = (typeof MARKETING_STATES)[number];

/** Where a customer gave or withdrew consent. contact_changed: a new number or email reset it. */
export const CONSENT_SOURCES = [
  'manual',
  'api',
  'import',
  'checkout',
  'reply',
  'contact_changed',
  'storefront',
] as const;
export type ConsentSourceValue = (typeof CONSENT_SOURCES)[number];

export const CONSENT_ACTOR_KINDS = ['app', 'staff', 'system'] as const;
export type ConsentActorKind = (typeof CONSENT_ACTOR_KINDS)[number];

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
    whatsappConsent: text('whatsapp_consent', { enum: MARKETING_STATES })
      .notNull()
      .default('not_subscribed'),
    whatsappConsentAt: timestamp('whatsapp_consent_at', { withTimezone: true }),
    smsConsent: text('sms_consent', { enum: MARKETING_STATES }).notNull().default('not_subscribed'),
    smsConsentAt: timestamp('sms_consent_at', { withTimezone: true }),
    emailConsent: text('email_consent', { enum: MARKETING_STATES })
      .notNull()
      .default('not_subscribed'),
    emailConsentAt: timestamp('email_consent_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type CustomerRow = typeof customers.$inferSelect;

/**
 * Every number of every customer, their main number (`customers.phone`) included. A number
 * belongs to one customer of a shop at a time.
 */
export const customerPhones = customersSchema.table(
  'customer_phones',
  {
    shopId: uuid('shop_id').notNull(),
    phone: text('phone').notNull(),
    customerId: uuid('customer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.phone] })],
);

/**
 * Erasures asked for after a waiting period, one per customer, until the worker's sweep carries
 * them out or staff cancel them (ADR-110).
 */
export const erasureRequests = customersSchema.table(
  'erasure_requests',
  {
    shopId: uuid('shop_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind', { enum: BLOCKER_KINDS }).notNull(),
    actorId: uuid('actor_id').notNull(),
    actorRole: text('actor_role'),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.customerId] })],
);

export const consentEvents = customersSchema.table(
  'consent_events',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    customerId: uuid('customer_id').notNull(),
    channel: text('channel', { enum: MARKETING_CHANNELS }).notNull(),
    state: text('state', { enum: MARKETING_STATES }).notNull(),
    source: text('source', { enum: CONSENT_SOURCES }).notNull(),
    wording: text('wording'),
    contact: text('contact').notNull(),
    actorKind: text('actor_kind', { enum: CONSENT_ACTOR_KINDS }).notNull(),
    actorId: uuid('actor_id'),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type ConsentEventRow = typeof consentEvents.$inferSelect;

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

export const segments = customersSchema.table(
  'segments',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    query: text('query').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type SegmentRow = typeof segments.$inferSelect;

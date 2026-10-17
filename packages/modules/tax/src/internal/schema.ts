// Drizzle mirror of the tax module's tables. The SQL migrations in db/migrations are the source of
// truth; tax.test.ts checks this file against the migrated database.
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { FbrEnvironment, FbrInvoiceBody, FiscalKind, FiscalStatus } from './fbr.js';
import type { FilerStatus, TaxCategoryValue, TaxProvince } from './tax.js';

export const taxSchema = pgSchema('tax');

/** A shop's sales tax (ADR-096); a shop without a row charges none. */
export const taxSettings = taxSchema.table('settings', {
  shopId: uuid('shop_id').primaryKey(),
  /** Hundredths of a percent included in its prices: 1800 is 18%. Null: it charges none. */
  rate: integer('rate'),
  /** Whether delivery charges, and the fee for paying on delivery, include it too. */
  taxDelivery: boolean('tax_delivery').notNull().default(false),
  /** Rates of its own for products whose variants name their codes (ADR-097); at most 20. */
  categories: jsonb('categories').$type<TaxCategoryValue[]>().notNull().default([]),
  /** The NTN FBR registered the shop under (ADR-190): "1234567-8", or a CNIC's 13 digits. */
  ntn: text('ntn'),
  /** Its sales tax registration number: 13 digits. */
  strn: text('strn'),
  /** The province its business is registered in (ADR-500). */
  province: text('province').$type<TaxProvince>(),
  /** Whether it is on FBR's Active Taxpayers List: active, inactive or unknown. */
  filerStatus: text('filer_status').$type<FilerStatus>().notNull().default('unknown'),
  /** Whether it is a Tier-1 retailer. */
  tier1: boolean('tier1').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The shop's POS as FBR registered it (ADR-555); a shop without a row reports nothing. */
export const fbrPos = taxSchema.table('fbr_pos', {
  shopId: uuid('shop_id').primaryKey(),
  posId: bigint('pos_id', { mode: 'number' }).notNull(),
  /** Sealed for the shop alone, and never shown again. */
  accessToken: text('access_token').notNull(),
  tokenHint: text('token_hint').notNull(),
  environment: text('environment').$type<FbrEnvironment>().notNull(),
  /** The PCT code its items are reported under, 8 digits. */
  pctCode: text('pct_code').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Each invoice and credit note the shop issued while connected, as FBR is sent it. */
export const fiscalInvoices = taxSchema.table(
  'fiscal_invoices',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    kind: text('kind').$type<FiscalKind>().notNull(),
    /** The shop's own number for it, FBR's USIN. */
    usin: text('usin').notNull(),
    orderId: uuid('order_id').notNull(),
    /** What FBR is sent, but the POS ID and items' PCT code. */
    payload: jsonb('payload').$type<FbrInvoiceBody>().notNull(),
    status: text('status').$type<FiscalStatus>().notNull().default('pending'),
    fbrInvoiceNumber: text('fbr_invoice_number'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    error: text('error'),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

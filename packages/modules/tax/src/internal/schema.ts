// Drizzle mirror of the tax module's tables. The SQL migrations in db/migrations are the source of
// truth; tax.test.ts checks this file against the migrated database.
import { boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { TaxCategoryValue } from './tax.js';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

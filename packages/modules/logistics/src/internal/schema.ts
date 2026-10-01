// Drizzle mirror of the logistics module's tables. The SQL migrations in db/migrations are the
// source of truth; remittances.test.ts checks this file against the migrated database.
import {
  bigint,
  customType,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const logisticsSchema = pgSchema('logistics');

/**
 * What became of a statement's line: its cash received in full on the parcel's order, received
 * short of what the order owed, or more than it owed; no parcel with its tracking number; the
 * parcel's cash received before; an order that owes nothing; or the courier's charges alone,
 * with no cash, on an order that owes none, as for a parcel sent back.
 */
export const REMITTANCE_OUTCOMES = [
  'received',
  'short',
  'over',
  'unmatched',
  'repeated',
  'not_owed',
  'charged',
] as const;
export type RemittanceOutcomeValue = (typeof REMITTANCE_OUTCOMES)[number];

export const ACTOR_KINDS = ['staff', 'app'] as const;

const money = (name: string) => bigint(name, { mode: 'bigint' });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const codRemittances = logisticsSchema.table(
  'cod_remittances',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    courier: text('courier').notNull(),
    reference: text('reference'),
    lineCount: integer('line_count').notNull(),
    collected: money('collected').notNull(),
    charges: money('charges').notNull(),
    tax: money('tax').notNull(),
    paid: money('paid').notNull(),
    received: money('received').notNull(),
    /** SHA-256 of its lines as read; null for statements imported before ADR-088. */
    digest: bytea('digest'),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const codRemittanceLines = logisticsSchema.table(
  'cod_remittance_lines',
  {
    shopId: uuid('shop_id').notNull(),
    remittanceId: uuid('remittance_id').notNull(),
    fileRow: integer('file_row').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    fulfillmentId: uuid('fulfillment_id'),
    orderId: uuid('order_id'),
    orderNumber: integer('order_number'),
    outcome: text('outcome', { enum: REMITTANCE_OUTCOMES }).notNull(),
    collected: money('collected').notNull(),
    charges: money('charges').notNull(),
    tax: money('tax').notNull(),
    owed: money('owed'),
    received: money('received').notNull().default(0n),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.remittanceId, table.fileRow] })],
);

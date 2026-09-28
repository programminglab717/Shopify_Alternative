// Drizzle mirror of the inventory tables. The SQL migrations in db/migrations are the source of
// truth; inventory.test.ts checks this file against the migrated database.
import { sql } from 'drizzle-orm';
import { boolean, integer, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const inventorySchema = pgSchema('inventory');

export const INVENTORY_POLICIES = ['deny', 'continue'] as const;
export type InventoryPolicyValue = (typeof INVENTORY_POLICIES)[number];

/** The stored quantities of a level; available is derived from them. */
export const QUANTITY_NAMES = ['on_hand', 'committed', 'reserved', 'safety_stock'] as const;
export type QuantityName = (typeof QUANTITY_NAMES)[number];

export const ACTOR_KINDS = ['app', 'staff', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const locations = inventorySchema.table(
  'locations',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    provinceCode: text('province_code'),
    zip: text('zip'),
    phone: text('phone'),
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    fulfillsOnlineOrders: boolean('fulfills_online_orders').notNull().default(true),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type LocationRow = typeof locations.$inferSelect;

export const items = inventorySchema.table(
  'items',
  {
    shopId: uuid('shop_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    productId: uuid('product_id').notNull(),
    tracked: boolean('tracked').notNull(),
    inventoryPolicy: text('inventory_policy', { enum: INVENTORY_POLICIES })
      .notNull()
      .default('deny'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.variantId] })],
);

export const levels = inventorySchema.table(
  'levels',
  {
    shopId: uuid('shop_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    id: uuid('id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    committed: integer('committed').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    safetyStock: integer('safety_stock').notNull().default(0),
    available: integer('available').generatedAlwaysAs(
      sql`on_hand - committed - reserved - safety_stock`,
    ),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.shopId, table.variantId, table.locationId] })],
);

export const adjustments = inventorySchema.table(
  'adjustments',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    reason: text('reason').notNull(),
    referenceDocumentUri: text('reference_document_uri'),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const movements = inventorySchema.table(
  'movements',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    adjustmentId: uuid('adjustment_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    quantityName: text('quantity_name', { enum: QUANTITY_NAMES }).notNull(),
    delta: integer('delta').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    availableAfter: integer('available_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

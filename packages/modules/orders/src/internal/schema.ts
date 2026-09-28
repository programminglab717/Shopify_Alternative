// Drizzle mirror of the orders tables. The SQL migrations in db/migrations are the source of truth;
// orders.test.ts checks this file against the migrated database.
import {
  bigint,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const ordersSchema = pgSchema('orders');

export const ORDER_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export const CONFIRMATION_STATUSES = [
  'not_required',
  'pending',
  'confirmed',
  'rejected',
  'no_response',
  'needs_review',
] as const;
export type ConfirmationStatusValue = (typeof CONFIRMATION_STATUSES)[number];

export const FINANCIAL_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'partially_refunded',
  'refunded',
  'voided',
] as const;
export type FinancialStatusValue = (typeof FINANCIAL_STATUSES)[number];

export const FULFILLMENT_STATUSES = [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
  'returned',
  'partially_returned',
] as const;
export type FulfillmentStatusValue = (typeof FULFILLMENT_STATUSES)[number];

/** The single state merchants see; see stageOf() in stages.ts. */
export const ORDER_STAGES = [
  'needs_confirmation',
  'needs_review',
  'to_fulfill',
  'partially_fulfilled',
  'in_transit',
  'returning',
  'delivered',
  'returned',
  'completed',
  'cancelled',
] as const;
export type OrderStageValue = (typeof ORDER_STAGES)[number];

/** Where orders come from. Only manual and api orders exist so far. */
export const ORDER_SOURCES = [
  'online_store',
  'whatsapp',
  'instagram',
  'facebook',
  'pos',
  'manual',
  'api',
  'marketplace',
  'reseller',
] as const;
export type OrderSourceValue = (typeof ORDER_SOURCES)[number];

/** Where a parcel is. */
export const PARCEL_STATUSES = ['in_transit', 'delivered', 'returning', 'returned'] as const;
export type ParcelStatusValue = (typeof PARCEL_STATUSES)[number];

export const PAYMENT_METHODS = ['cash_on_delivery', 'prepaid'] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const CANCEL_REASONS = ['customer', 'no_response', 'fraud', 'inventory', 'other'] as const;
export type CancelReasonValue = (typeof CANCEL_REASONS)[number];

export const ACTOR_KINDS = ['app', 'staff', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** A shipping address as an order keeps it. */
export interface AddressValue {
  name: string;
  /** Mobile number in E.164 form. */
  phone: string;
  address1: string;
  address2: string | null;
  city: string;
  provinceCode: string | null;
  zip: string | null;
}

const money = (name: string) => bigint(name, { mode: 'bigint' });

export const counters = ordersSchema.table('counters', {
  shopId: uuid('shop_id').primaryKey(),
  nextNumber: integer('next_number').notNull(),
});

export const orders = ordersSchema.table(
  'orders',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    number: integer('number').notNull(),
    source: text('source', { enum: ORDER_SOURCES }).notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('open'),
    confirmationStatus: text('confirmation_status', { enum: CONFIRMATION_STATUSES }).notNull(),
    financialStatus: text('financial_status', { enum: FINANCIAL_STATUSES }).notNull(),
    fulfillmentStatus: text('fulfillment_status', { enum: FULFILLMENT_STATUSES })
      .notNull()
      .default('unfulfilled'),
    stage: text('stage', { enum: ORDER_STAGES }).notNull(),
    paymentMethod: text('payment_method', { enum: PAYMENT_METHODS }).notNull(),
    currency: text('currency').notNull(),
    subtotal: money('subtotal').notNull(),
    discount: money('discount').notNull(),
    shipping: money('shipping').notNull(),
    total: money('total').notNull(),
    amountPaid: money('amount_paid').notNull(),
    codAmount: money('cod_amount').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    shippingAddress: jsonb('shipping_address').$type<AddressValue>().notNull(),
    locationId: uuid('location_id').notNull(),
    note: text('note').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    searchText: text('search_text').notNull().default(''),
    cancelReason: text('cancel_reason', { enum: CANCEL_REASONS }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type OrderRow = typeof orders.$inferSelect;

export const lines = ordersSchema.table(
  'lines',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    position: integer('position').notNull(),
    variantId: uuid('variant_id').notNull(),
    productId: uuid('product_id').notNull(),
    title: text('title').notNull(),
    variantTitle: text('variant_title').notNull(),
    sku: text('sku'),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    total: money('total').notNull(),
    weightGrams: integer('weight_grams'),
    fulfilledQuantity: integer('fulfilled_quantity').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type LineRow = typeof lines.$inferSelect;

export const fulfillments = ordersSchema.table(
  'fulfillments',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    locationId: uuid('location_id').notNull(),
    status: text('status', { enum: PARCEL_STATUSES }).notNull().default('in_transit'),
    trackingCompany: text('tracking_company'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    returningAt: timestamp('returning_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type FulfillmentRow = typeof fulfillments.$inferSelect;

export const fulfillmentLines = ordersSchema.table(
  'fulfillment_lines',
  {
    shopId: uuid('shop_id').notNull(),
    fulfillmentId: uuid('fulfillment_id').notNull(),
    lineId: uuid('line_id').notNull(),
    quantity: integer('quantity').notNull(),
    restockedQuantity: integer('restocked_quantity'),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.fulfillmentId, table.lineId] })],
);

export const orderEvents = ordersSchema.table(
  'order_events',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

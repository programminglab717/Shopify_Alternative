// Drizzle mirror of the orders tables. The SQL migrations in db/migrations are the source of truth;
// orders.test.ts checks this file against the migrated database.
import {
  bigint,
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
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

/** The single state merchants see; see stageOf() in rules.ts. */
export const ORDER_STAGES = [
  'needs_confirmation',
  'needs_review',
  'to_pack',
  'to_book',
  'partially_fulfilled',
  'in_transit',
  'returning',
  'delivered',
  'returned',
  'completed',
  'cancelled',
] as const;
export type OrderStageValue = (typeof ORDER_STAGES)[number];

/**
 * Where orders come from: staff's are manual, apps' api, checkout's online_store, and drafts'
 * the chat or call they came from. pos, marketplace and reseller are reserved.
 */
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

/** Where a draft order's conversation happened, or the app that sent it; its order takes it. */
export const DRAFT_ORDER_SOURCES = ['whatsapp', 'instagram', 'facebook', 'manual', 'api'] as const;
export type DraftOrderSourceValue = (typeof DRAFT_ORDER_SOURCES)[number];

export const DRAFT_ORDER_STATUSES = ['open', 'completed'] as const;
export type DraftOrderStatusValue = (typeof DRAFT_ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['cash_on_delivery', 'prepaid'] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const CANCEL_REASONS = ['customer', 'no_response', 'fraud', 'inventory', 'other'] as const;
export type CancelReasonValue = (typeof CANCEL_REASONS)[number];

/** How a refund went back to the customer. Staff send the money; Hatti records it. */
export const REFUND_METHODS = ['bank_transfer', 'mobile_wallet', 'cash', 'other'] as const;
export type RefundMethodValue = (typeof REFUND_METHODS)[number];

export const ACTOR_KINDS = ['app', 'staff', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** How likely a cash-on-delivery order is to come back unpaid; see risk.ts. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevelValue = (typeof RISK_LEVELS)[number];

/** Why an order scored what it did. */
export interface RiskReasonValue {
  /** e.g. "refused_deliveries", "high_value". */
  code: string;
  message: string;
  /** Points out of 100 it adds; negative points lower the risk. */
  weight: number;
}

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

/**
 * What an order keeps of its address once its customer's data is erased: where it went, for the
 * shop's accounts.
 */
export interface ErasedAddressValue {
  name: null;
  phone: null;
  address1: null;
  address2: null;
  city: string;
  provinceCode: string | null;
  zip: null;
}

/** An order's shipping address as stored: whole, or what is left after an erasure. */
export type StoredAddressValue = AddressValue | ErasedAddressValue;

/** A draft order's line as stored: the item at the price agreed, as it was when added. */
export interface DraftLineValue {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** Minor units, as a string, so that no amount loses precision in JSON. */
  unitPrice: string;
}

const money = (name: string) => bigint(name, { mode: 'bigint' });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

export const counters = ordersSchema.table('counters', {
  shopId: uuid('shop_id').primaryKey(),
  nextNumber: integer('next_number').notNull(),
  nextDraftNumber: integer('next_draft_number').notNull().default(1),
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
    /** Given back since; never more than was paid. */
    amountRefunded: money('amount_refunded').notNull().default(0n),
    codAmount: money('cod_amount').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Null once the customer's data is erased. */
    phone: text('phone'),
    email: text('email'),
    shippingAddress: jsonb('shipping_address').$type<StoredAddressValue>().notNull(),
    locationId: uuid('location_id').notNull(),
    note: text('note').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    searchText: text('search_text').notNull().default(''),
    cancelReason: text('cancel_reason', { enum: CANCEL_REASONS }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    packedAt: timestamp('packed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    riskScore: smallint('risk_score'),
    riskLevel: text('risk_level', { enum: RISK_LEVELS }),
    riskReasons: jsonb('risk_reasons').$type<RiskReasonValue[]>().notNull().default([]),
    customerErasedAt: timestamp('customer_erased_at', { withTimezone: true }),
    /** SHA-256 of the customer's link's secret. */
    linkTokenHash: bytea('link_token_hash'),
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }),
    /**
     * The versions of the shop's policies its customer agreed to in placing it through checkout
     * (ADR-057); null for orders staff and apps place.
     */
    agreedPolicyVersions: uuid('agreed_policy_versions').array(),
    /** The discount codes it was placed with, as the shop wrote them. */
    discountCodes: text('discount_codes').array().notNull().default([]),
    /** Where its customer placed it from; null once their data is erased. */
    clientIp: inet('client_ip'),
    clientUserAgent: text('client_user_agent'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type OrderRow = typeof orders.$inferSelect;

/** A shop's risk policy; shops without one have the defaults. */
export const riskSettings = ordersSchema.table('risk_settings', {
  shopId: uuid('shop_id').primaryKey(),
  holdAt: smallint('hold_at'),
  highValue: money('high_value').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export const refunds = ordersSchema.table(
  'refunds',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    amount: money('amount').notNull(),
    method: text('method', { enum: REFUND_METHODS }).notNull(),
    reference: text('reference'),
    note: text('note').notNull().default(''),
    actorKind: text('actor_kind', { enum: ['app', 'staff'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export const draftOrders = ordersSchema.table(
  'draft_orders',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    number: integer('number').notNull(),
    status: text('status', { enum: DRAFT_ORDER_STATUSES }).notNull().default('open'),
    source: text('source', { enum: DRAFT_ORDER_SOURCES }).notNull(),
    paymentMethod: text('payment_method', { enum: PAYMENT_METHODS }).notNull(),
    currency: text('currency').notNull(),
    lines: jsonb('lines').$type<DraftLineValue[]>().notNull(),
    subtotal: money('subtotal').notNull(),
    discount: money('discount').notNull(),
    shipping: money('shipping').notNull(),
    total: money('total').notNull(),
    advancePaid: money('advance_paid').notNull(),
    /** The customer's number and address, both or neither. */
    phone: text('phone'),
    email: text('email'),
    shippingAddress: jsonb('shipping_address').$type<AddressValue>(),
    /** Null: the primary location when it is placed. */
    locationId: uuid('location_id'),
    note: text('note').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    orderId: uuid('order_id'),
    /** SHA-256 of the customer's link's secret. */
    linkTokenHash: bytea('link_token_hash'),
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }),
    actorKind: text('actor_kind', { enum: ['app', 'staff'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type DraftOrderRow = typeof draftOrders.$inferSelect;

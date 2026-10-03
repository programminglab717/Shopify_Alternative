// Drizzle mirror of the orders tables. The SQL migrations in db/migrations are the source of truth;
// orders.test.ts checks this file against the migrated database.
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
  uuid,
} from 'drizzle-orm/pg-core';
import type { AttributionValue } from './attribution.js';
import type { BrowserIdsValue } from './browser-ids.js';

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
  'awaiting_payment',
  'to_pack',
  'to_book',
  'partially_fulfilled',
  'in_transit',
  'returning',
  'delivered',
  'returned',
  'lost',
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

/** Where a parcel is: `lost` when its courier lost it, on its way out or back. */
export const PARCEL_STATUSES = [
  'in_transit',
  'delivered',
  'returning',
  'returned',
  'lost',
] as const;
export type ParcelStatusValue = (typeof PARCEL_STATUSES)[number];

/**
 * What became of a claim on a courier for a parcel it lost (ADR-093): waiting for the courier,
 * paid, refused by the courier, or withdrawn by the shop.
 */
export const PARCEL_CLAIM_STATUSES = ['open', 'paid', 'refused', 'withdrawn'] as const;
export type ParcelClaimStatusValue = (typeof PARCEL_CLAIM_STATUSES)[number];

/** Where a draft order's conversation happened, or the app that sent it; its order takes it. */
export const DRAFT_ORDER_SOURCES = ['whatsapp', 'instagram', 'facebook', 'manual', 'api'] as const;
export type DraftOrderSourceValue = (typeof DRAFT_ORDER_SOURCES)[number];

export const DRAFT_ORDER_STATUSES = ['open', 'completed'] as const;
export type DraftOrderStatusValue = (typeof DRAFT_ORDER_STATUSES)[number];

/**
 * How an order is paid: in cash at the door, before it was placed, or by a bank transfer its
 * customer makes after placing it, which staff mark paid once the money is in (ADR-074).
 */
export const PAYMENT_METHODS = ['cash_on_delivery', 'prepaid', 'bank_transfer', 'online'] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const CANCEL_REASONS = [
  'customer',
  'no_response',
  'fraud',
  'inventory',
  'other',
  /** Merged into another order of its customer, which took its items (ADR-132). */
  'merged',
  /** Not paid in the days its shop allows (ADR-168). */
  'unpaid',
] as const;
export type CancelReasonValue = (typeof CANCEL_REASONS)[number];

/**
 * How a refund went back to the customer. Staff send the money; Hatti records it. By `exchange`,
 * none moves: it pays for the exchange a return sends (ADR-137). `online` went back through the
 * payment gateway the customer paid with, which Hatti asked to send it (ADR-153).
 */
export const REFUND_METHODS = [
  'bank_transfer',
  'mobile_wallet',
  'cash',
  'other',
  'exchange',
  'online',
] as const;
export type RefundMethodValue = (typeof REFUND_METHODS)[number];

/** Where a customer return is (ADR-136): coming back, checked in, or not coming after all. */
export const RETURN_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type ReturnStatusValue = (typeof RETURN_STATUSES)[number];

/** Why a customer sends an item back, as Shopify's return reasons say it. */
export const RETURN_REASONS = [
  'size_too_small',
  'size_too_large',
  'unwanted',
  'not_as_described',
  'wrong_item',
  'defective',
  'other',
] as const;
export type ReturnReasonValue = (typeof RETURN_REASONS)[number];

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

/** A bank account customers pay into by transfer, as an order keeps it (ADR-074). */
export interface BankAccountValue {
  /** The account's title, as its bank has it: whose account it is. */
  title: string;
  /** As customers pick it in their banking apps: "Meezan Bank". */
  bankName: string;
  /** Pakistani, unspaced: "PK36SCBL0000001123456702". */
  iban: string;
  /** What customers are told besides, such as where to send the receipt; empty for nothing. */
  instructions: string;
  /**
   * The mobile number its bank registered for Raast, in E.164, "+923001234567", which customers'
   * banking apps pay to (ADR-082); null for none, as for orders placed before it was kept.
   */
  raastId: string | null;
}

/** A shipping address as an order keeps it. */
export interface AddressValue {
  name: string;
  /** Mobile number in E.164 form. */
  phone: string;
  /** The house and street: "House 12, Street 4, Block 5". */
  address1: string;
  /** The area: "Gulshan-e-Iqbal", as an address's second line has it here. */
  address2: string | null;
  /** A place near it the rider can ask for: "near Jamia Masjid". */
  landmark: string | null;
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
  landmark: null;
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
    /** What it charges for paying on delivery (CHK-08); in its total. */
    codFee: money('cod_fee').notNull().default(0n),
    /** The shop's sales tax when it was placed (ADR-096): hundredths of a percent; null: none. */
    taxRate: integer('tax_rate'),
    /** The tax included in its total, and of that, in its delivery charge and fee. */
    totalTax: money('total_tax').notNull().default(0n),
    shippingTax: money('shipping_tax').notNull().default(0n),
    /** Of `discount`, what was taken off for paying by bank transfer (CHK-08, ADR-077). */
    transferDiscount: money('transfer_discount').notNull().default(0n),
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
    /** The order it was merged into, cancelled as `merged` (ADR-132). */
    mergedIntoId: uuid('merged_into_id'),
    /**
     * The order it was split from (ADR-135), the first one when a part is split again: it and
     * its parts are scored as the one order their customer placed.
     */
    splitFromId: uuid('split_from_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** When its customer proved its number with a code, at checkout (CHK-09, ADR-148). */
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    packedAt: timestamp('packed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** When its customer was reminded to pay before it is cancelled unpaid (ADR-174). */
    paymentRemindedAt: timestamp('payment_reminded_at', { withTimezone: true }),
    /** When its customer was asked once more to confirm it (ADR-175). */
    confirmationRemindedAt: timestamp('confirmation_reminded_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The member of staff it is given to, to see through (ADR-127): their account's ID. */
    assigneeId: uuid('assignee_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    riskScore: smallint('risk_score'),
    riskLevel: text('risk_level', { enum: RISK_LEVELS }),
    riskReasons: jsonb('risk_reasons').$type<RiskReasonValue[]>().notNull().default([]),
    customerErasedAt: timestamp('customer_erased_at', { withTimezone: true }),
    /** SHA-256 of the customer's link's secret. */
    linkTokenHash: bytea('link_token_hash'),
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }),
    /**
     * The versions of the shop's policies its customer agreed to in placing it through checkout
     * (ADR-057), or confirming it, or its draft, through a link (ADR-114, ADR-115); null for
     * orders staff and apps place until their customers confirm them so.
     */
    agreedPolicyVersions: uuid('agreed_policy_versions').array(),
    /** When they agreed: when it was placed, or confirmed through its link; null with the above. */
    agreedAt: timestamp('agreed_at', { withTimezone: true }),
    /** The discount codes it was placed with, as the shop wrote them. */
    discountCodes: text('discount_codes').array().notNull().default([]),
    /** Where its customer placed it from; null once their data is erased. */
    clientIp: inet('client_ip'),
    clientUserAgent: text('client_user_agent'),
    /**
     * Where its customer came to the online store from before placing it, as checkout kept it
     * (ADR-139): their first and last visits; null for orders placed otherwise.
     */
    attribution: jsonb('attribution').$type<AttributionValue>(),
    /**
     * The IDs the shop's Meta pixel gave its customer's browser, as checkout passed them (MKT-10,
     * ADR-144); null for orders placed otherwise, and once their data is erased.
     */
    browserIds: jsonb('browser_ids').$type<BrowserIdsValue>(),
    /** Calls the customer did not answer since it was placed (COD-04). */
    unansweredCalls: smallint('unanswered_calls').notNull().default(0),
    /** When it is due for a call again; null: since it was placed. */
    confirmationDueAt: timestamp('confirmation_due_at', { withTimezone: true }),
    /** Who is calling the customer now, until when: the queue's, not the order's. */
    claimedByKind: text('claimed_by_kind', { enum: ['app', 'staff'] }),
    claimedBy: uuid('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    /**
     * The account a bank-transfer order's customer was told to pay into, as it was when it was
     * placed, or a cash-on-delivery order's for its advance; null when the shop had none.
     */
    bankAccount: jsonb('bank_account').$type<BankAccountValue>(),
    /**
     * What a cash-on-delivery order asks for in advance, by transfer, before it ships (ADR-083);
     * minor units, zero for none. Received, it counts in amountPaid.
     */
    advanceDue: money('advance_due').notNull().default(0n),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type OrderRow = typeof orders.$inferSelect;

/** How a call to confirm an order went, short of confirming or cancelling it. */
export const CONFIRMATION_CALL_OUTCOMES = ['no_answer', 'call_back', 'wrong_number'] as const;
export type ConfirmationCallOutcomeValue = (typeof CONFIRMATION_CALL_OUTCOMES)[number];

/** Each call made to confirm an order (COD-04). */
export const confirmationCalls = ordersSchema.table(
  'confirmation_calls',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    outcome: text('outcome', { enum: CONFIRMATION_CALL_OUTCOMES }).notNull(),
    callBackAt: timestamp('call_back_at', { withTimezone: true }),
    note: text('note').notNull().default(''),
    actorKind: text('actor_kind', { enum: ['app', 'staff', 'system'] }).notNull(),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

/** A shop's risk policy; shops without one have the defaults. */
export const riskSettings = ordersSchema.table('risk_settings', {
  shopId: uuid('shop_id').primaryKey(),
  holdAt: smallint('hold_at'),
  highValue: money('high_value').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How long a cash-on-delivery customer may cancel their order through its link: while it waits
 * for them to confirm it, or until it is packed, though they confirmed it.
 */
export const CUSTOMER_CANCELLATIONS = ['until_confirmed', 'until_packed'] as const;
export type CustomerCancellationValue = (typeof CUSTOMER_CANCELLATIONS)[number];

/** A shop's policies for its orders, but for risk; shops without them have the defaults. */
export const orderSettings = ordersSchema.table('order_settings', {
  shopId: uuid('shop_id').primaryKey(),
  customerCancellation: text('customer_cancellation', { enum: CUSTOMER_CANCELLATIONS })
    .notNull()
    .default('until_packed'),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The bank account a shop's customers pay into by transfer (ADR-074): checkout offers bank
 * transfer while it is enabled. Shops without a row have none.
 */
export const bankTransferSettings = ordersSchema.table('bank_transfer_settings', {
  shopId: uuid('shop_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** The account, all three or none. */
  accountTitle: text('account_title'),
  bankName: text('bank_name'),
  iban: text('iban'),
  instructions: text('instructions').notNull().default(''),
  /**
   * What checkout takes off orders paid by transfer (CHK-08, ADR-077): hundredths of a percent of
   * the items, up to a cap if set, or an amount; one of the two, or neither.
   */
  discountBps: integer('discount_bps'),
  discountCap: money('discount_cap'),
  discountAmount: money('discount_amount'),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Receipts of bank transfers that customers sent through their orders' pages (PAY-02, ADR-080),
 * kept in object storage.
 */
export const transferReceipts = ordersSchema.table(
  'transfer_receipts',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    /** Where storage keeps it: shops/{shopId}/receipts/{orderId}/{id}.{extension}. */
    key: text('key').notNull(),
    contentType: text('content_type').notNull(),
    /** Bytes. */
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

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
    /**
     * What one unit cost the shop when it was sold (ANL-03, ADR-141), its variant's cost then;
     * null when it had none.
     */
    unitCost: money('unit_cost'),
    weightGrams: integer('weight_grams'),
    fulfilledQuantity: integer('fulfilled_quantity').notNull().default(0),
    /** Whether its variant's price included the shop's sales tax when it was sold (ADR-096). */
    taxable: boolean('taxable').notNull().default(true),
    /** The rate it was taxed at, hundredths of a percent; null: none. */
    taxRate: integer('tax_rate'),
    /** What of its total, after its share of the order's discount, was tax. */
    tax: money('tax').notNull().default(0n),
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
    lostAt: timestamp('lost_at', { withTimezone: true }),
    /** What couriers' statements charged for it, both ways (ADR-088); null while none has. */
    courierCharges: money('courier_charges'),
    /** Its claim on the courier that lost it (ADR-093); null while it has none. */
    claimStatus: text('claim_status', { enum: PARCEL_CLAIM_STATUSES }),
    claimAmount: money('claim_amount'),
    claimPaid: money('claim_paid'),
    claimNote: text('claim_note'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimSettledAt: timestamp('claim_settled_at', { withTimezone: true }),
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

/**
 * A step of a parcel's way to its customer, as Shopify's FulfillmentEvent names it (SHP-05,
 * ADR-160): `confirmed` once its courier booked it; `returning` and `returned` are Hatti's own, for
 * a parcel going back to the shop, and `failure` one its courier lost or gave up.
 */
export const FULFILLMENT_EVENT_STATUSES = [
  'confirmed',
  'in_transit',
  'out_for_delivery',
  'attempted_delivery',
  'delivered',
  'returning',
  'returned',
  'failure',
] as const;
export type FulfillmentEventStatusValue = (typeof FULFILLMENT_EVENT_STATUSES)[number];

export const fulfillmentEvents = ordersSchema.table(
  'fulfillment_events',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    fulfillmentId: uuid('fulfillment_id').notNull(),
    status: text('status', { enum: FULFILLMENT_EVENT_STATUSES }).notNull(),
    message: text('message'),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull(),
    sourceKey: text('source_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
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

/** Who writes a comment: a member of staff or an app, never the system. */
export const COMMENT_AUTHOR_KINDS = ['app', 'staff'] as const;
export type CommentAuthorKind = (typeof COMMENT_AUTHOR_KINDS)[number];

/** Comments staff and apps write on an order's timeline (ADR-128): their authors' to change. */
export const orderComments = ordersSchema.table(
  'order_comments',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    message: text('message').notNull(),
    authorKind: text('author_kind', { enum: COMMENT_AUTHOR_KINDS }).notNull(),
    authorId: uuid('author_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
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
    /** What of it was sales tax (ADR-105). */
    tax: money('tax').notNull(),
    method: text('method', { enum: REFUND_METHODS }).notNull(),
    reference: text('reference'),
    note: text('note').notNull().default(''),
    actorKind: text('actor_kind', { enum: ['app', 'staff'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

/** A customer sending back items of a delivered parcel (ORD-07, ADR-136). */
export const returns = ordersSchema.table(
  'returns',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    orderId: uuid('order_id').notNull(),
    /** The order's first return is 1, named #1001-R1. */
    number: integer('number').notNull(),
    status: text('status', { enum: RETURN_STATUSES }).notNull().default('open'),
    /** Where its items come back to, and go back in stock. */
    locationId: uuid('location_id').notNull(),
    trackingCompany: text('tracking_company'),
    trackingNumber: text('tracking_number'),
    note: text('note').notNull().default(''),
    /** The order sent in exchange for what comes back (ADR-137), if any. */
    exchangeOrderId: uuid('exchange_order_id'),
    actorKind: text('actor_kind', { enum: ['app', 'staff'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type ReturnRow = typeof returns.$inferSelect;

export const returnLines = ordersSchema.table(
  'return_lines',
  {
    shopId: uuid('shop_id').notNull(),
    returnId: uuid('return_id').notNull(),
    lineId: uuid('line_id').notNull(),
    quantity: integer('quantity').notNull(),
    reason: text('reason', { enum: RETURN_REASONS }).notNull(),
    /** Units back in stock once it is checked in; the rest were written off. */
    restockedQuantity: integer('restocked_quantity'),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.returnId, table.lineId] })],
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
    /**
     * Asked for in advance by transfer on a cash-on-delivery draft, not beside `advancePaid`:
     * its order waits for it (ADR-085).
     */
    advanceDue: money('advance_due').notNull().default(0n),
    /** The customer's number and address, both or neither. */
    phone: text('phone'),
    email: text('email'),
    shippingAddress: jsonb('shipping_address').$type<AddressValue>(),
    /** Null: the primary location when it is placed. */
    locationId: uuid('location_id'),
    note: text('note').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    /** Its customer's name, city and email, folded, as a search of the drafts matches them. */
    searchText: text('search_text').notNull().default(''),
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

/**
 * A search of the orders list the shop keeps by name, shop-wide, as Shopify's saved searches
 * (ADR-119): its query as orders(query:) takes it, checked when saved.
 */
/** The lists a saved search may search (ADR-124), as Shopify's `SearchResultType` names them. */
export const SAVED_SEARCH_TYPES = ['order', 'draft_order', 'product'] as const;
export type SavedSearchTypeValue = (typeof SAVED_SEARCH_TYPES)[number];

export const savedSearches = ordersSchema.table(
  'saved_searches',
  {
    shopId: uuid('shop_id').notNull(),
    id: uuid('id').notNull(),
    resourceType: text('resource_type', { enum: SAVED_SEARCH_TYPES }).notNull(),
    name: text('name').notNull(),
    query: text('query').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.id] })],
);

export type SavedSearchRow = typeof savedSearches.$inferSelect;

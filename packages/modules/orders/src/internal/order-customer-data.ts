import {
  CustomerDataRegistry,
  type CustomerDataHandler,
  type CustomerIdentity,
} from '@hatti/customers/public';
import { toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, type PkProvinceCode } from '@hatti/pk';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { toDraftRecord } from './draft-order.service.js';
import { OrderEvents, type OrderReceiptsErasedPayload } from './events.js';
import { actorColumns, loadOrders } from './order-store.js';
import type { DraftOrderRecord, OrderRecord } from './records.js';
import { draftName, orderName } from './rules.js';
import { draftOrders, type StoredAddressValue } from './schema.js';

/** The most open orders a refused erasure names. */
const NAMED = 5;

/**
 * Orders' part in merging and erasing customers. A merged duplicate's orders become the
 * customer's. An erased customer's orders keep what the shop's accounts need: the items, amounts,
 * statuses and dates, and the city and province they went to; the name, number, email, street
 * and note go, as do the address and browser they were placed from, the notes and references of
 * their refunds, the comments on their timelines and the receipts they sent for transfers, whose
 * files nothing signs a URL for after; and the timeline says so. The policies they agreed to stay: those are the shop's words,
 * not the customer's (ADR-057).
 * Timeline messages never hold contact details, so they stay as they are. Their orders' links
 * stop working, since their pages show the address. Their draft orders go: those that became
 * their orders, and open ones with one of their numbers or their email.
 *
 * A customer's own export (ADR-102) gives them the same orders and drafts whole, with their
 * parcels, refunds, calls to confirm them and the receipts they sent. Risk scores and the
 * timeline, its comments too, stay out: the shop's defences against fraud, and its record of its
 * own work.
 */
export const ORDER_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'orders',

  async erasureBlockers(tx, shopId, customerId) {
    const { rows } = await tx.execute<{ number: number }>(sql`
      SELECT number FROM orders.orders
       WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND status = 'open'
       ORDER BY number
       LIMIT ${NAMED + 1}`);
    if (rows.length === 0) return [];
    const named = rows.slice(0, NAMED).map((row) => orderName(row.number));
    return [
      'Their orders must be closed or cancelled first; still open: ' +
        named.join(', ') +
        (rows.length > NAMED ? ' and more' : ''),
    ];
  },

  async merge(tx, shopId, fromId, intoId) {
    await tx.execute(sql`
      UPDATE orders.orders
         SET customer_id = ${intoId}, version = version + 1, updated_at = now()
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  async erase(tx, shopId, customer, actor) {
    const customerId = customer.id;
    const { actorKind, actorId } = actorColumns(actor);
    // Drafts name no customer, and a completed one holds its order's address: they go first.
    await tx.execute(sql`
      DELETE FROM orders.draft_orders d
       WHERE d.shop_id = ${shopId}
         AND (d.phone = ANY(${sql.param(customer.phones)}::text[])
              OR lower(d.email) = lower(${customer.email}::text)
              OR d.order_id IN (SELECT o.id FROM orders.orders o
                                 WHERE o.shop_id = ${shopId} AND o.customer_id = ${customerId}))`);
    await tx.execute(sql`
      WITH erased AS (
        UPDATE orders.orders
           SET phone = NULL, email = NULL, note = '', search_text = '',
               link_token_hash = NULL, link_expires_at = NULL,
               client_ip = NULL, client_user_agent = NULL,
               shipping_address = jsonb_build_object(
                 'name', NULL, 'phone', NULL, 'address1', NULL, 'address2', NULL,
                 'landmark', NULL, 'city', shipping_address -> 'city',
                 'provinceCode', shipping_address -> 'provinceCode', 'zip', NULL),
               customer_erased_at = now(), version = version + 1, updated_at = now()
         WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        RETURNING id),
      -- A refund's note and reference may name the customer or their wallet; the amount stays.
      cleared AS (
        UPDATE orders.refunds r
           SET note = '', reference = NULL
          FROM erased
         WHERE r.shop_id = ${shopId} AND r.order_id = erased.id),
      -- So may a return's note (ADR-136); what came back, and why, stays.
      returned AS (
        UPDATE orders.returns rt
           SET note = ''
          FROM erased
         WHERE rt.shop_id = ${shopId} AND rt.order_id = erased.id),
      -- So may an agent's note on a call; how the call went stays.
      calls AS (
        UPDATE orders.confirmation_calls c
           SET note = ''
          FROM erased
         WHERE c.shop_id = ${shopId} AND c.order_id = erased.id),
      -- And so may comments staff and apps wrote on the orders (ADR-128): they go.
      comments AS (
        DELETE FROM orders.order_comments m
         USING erased
         WHERE m.shop_id = ${shopId} AND m.order_id = erased.id)
      INSERT INTO orders.order_events (shop_id, id, order_id, kind, message, actor_kind, actor_id)
      SELECT ${shopId}, platform.uuidv7(), id, 'erased',
             'The customer''s details were erased at their request', ${actorKind}, ${actorId}
        FROM erased`);
    // And their receipts, which show their name and account: the payment stays on the order. The
    // files go after the erasure commits, by the worker, as each order's event says (ADR-113).
    const { rows: receipts } = await tx.execute<{ order_id: string; key: string }>(sql`
      DELETE FROM orders.transfer_receipts t
       USING orders.orders o
       WHERE t.shop_id = ${shopId} AND o.shop_id = ${shopId} AND o.id = t.order_id
         AND o.customer_id = ${customerId}
      RETURNING t.order_id, t.key`);
    const keysByOrder = new Map<string, string[]>();
    for (const { order_id: orderId, key } of receipts) {
      keysByOrder.set(orderId, [...(keysByOrder.get(orderId) ?? []), key]);
    }
    for (const [orderId, keys] of keysByOrder) {
      await appendEvent<OrderReceiptsErasedPayload>(tx, shopId, {
        type: OrderEvents.OrderReceiptsErased,
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { keys },
      });
    }
  },

  async export(tx, shopId, customer) {
    const orders = await loadOrders(tx, shopId, {
      where: sql`o.customer_id = ${customer.id}`,
      order: sql`o.number`,
    });
    const orderIds = orders.map((order) => order.id);
    const { rows: calls } = await tx.execute<CallRow>(sql`
      SELECT order_id, outcome, call_back_at, note, created_at
        FROM orders.confirmation_calls
       WHERE shop_id = ${shopId} AND order_id = ANY(${sql.param(orderIds)}::uuid[])
       ORDER BY id`);
    const { rows: receipts } = await tx.execute<ReceiptRow>(sql`
      SELECT id, order_id, content_type, size, created_at
        FROM orders.transfer_receipts
       WHERE shop_id = ${shopId} AND order_id = ANY(${sql.param(orderIds)}::uuid[])
       ORDER BY id`);
    const drafts = await draftsOf(tx, shopId, customer, orderIds);
    return {
      orders: orders.map((order) =>
        exportedOrder(
          order,
          calls.filter((call) => call.order_id === order.id),
          receipts.filter((receipt) => receipt.order_id === order.id),
        ),
      ),
      draftOrders: drafts.map(exportedDraft),
    };
  },
};

type CallRow = {
  order_id: string;
  outcome: string;
  call_back_at: Date | string | null;
  note: string;
  created_at: Date | string;
};

type ReceiptRow = {
  id: string;
  order_id: string;
  content_type: string;
  size: number;
  created_at: Date | string;
};

/** As erasure finds them: drafts with one of their numbers or their email, or of their orders. */
async function draftsOf(
  tx: Tx,
  shopId: string,
  customer: CustomerIdentity,
  orderIds: string[],
): Promise<DraftOrderRecord[]> {
  const rows = await tx
    .select()
    .from(draftOrders)
    .where(
      and(
        eq(draftOrders.shopId, shopId),
        sql`(${draftOrders.phone} = ANY(${sql.param(customer.phones)}::text[])
             OR lower(${draftOrders.email}) = lower(${customer.email}::text)
             OR ${draftOrders.orderId} = ANY(${sql.param(orderIds)}::uuid[]))`,
      ),
    )
    .orderBy(asc(draftOrders.number));
  return rows.map(toDraftRecord);
}

/** An address in the order it is written, with its province's name. */
function exportedAddress(address: StoredAddressValue | null) {
  return (
    address && {
      name: address.name,
      phone: address.phone,
      address1: address.address1,
      address2: address.address2,
      landmark: address.landmark,
      city: address.city,
      province: address.provinceCode
        ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
        : null,
      zip: address.zip,
    }
  );
}

/** Amounts in the file: "2100.00", as the order exports write them. */
function amountIn(currency: CurrencyCode): (value: bigint) => string {
  return (value) => toMajorString(money(value, currency));
}

function exportedOrder(order: OrderRecord, calls: CallRow[], receipts: ReceiptRow[]) {
  const amount = amountIn(order.currency);
  return {
    id: toPublicId('order', order.id),
    name: orderName(order.number),
    placedAt: order.createdAt,
    source: order.source,
    status: order.status,
    confirmationStatus: order.confirmationStatus,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    lineItems: order.lines.map((line) => ({
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: amount(line.unitPrice),
      total: amount(line.total),
    })),
    subtotal: amount(order.subtotal),
    discount: amount(order.discount),
    discountCodes: order.discountCodes,
    shipping: amount(order.shipping),
    codFee: amount(order.codFee),
    tax: amount(order.totalTax),
    total: amount(order.total),
    paid: amount(order.amountPaid),
    refunded: amount(order.amountRefunded),
    phone: order.phone,
    email: order.email,
    shippingAddress: exportedAddress(order.shippingAddress),
    note: order.note,
    tags: order.tags,
    agreement: order.agreement && {
      policyVersionIds: order.agreement.policyVersions.map((id) =>
        toPublicId('shopPolicyVersion', id),
      ),
      agreedAt: order.agreement.agreedAt,
      ip: order.agreement.ip,
      userAgent: order.agreement.userAgent,
    },
    confirmedAt: order.confirmedAt,
    paidAt: order.paidAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    closedAt: order.closedAt,
    parcels: order.fulfillments.map((parcel) => ({
      id: toPublicId('fulfillment', parcel.id),
      status: parcel.status,
      courier: parcel.trackingCompany,
      trackingNumber: parcel.trackingNumber,
      trackingUrl: parcel.trackingUrl,
      shippedAt: parcel.shippedAt,
      deliveredAt: parcel.deliveredAt,
      returningAt: parcel.returningAt,
      returnedAt: parcel.returnedAt,
      lostAt: parcel.lostAt,
    })),
    refunds: order.refunds.map((refund) => ({
      id: toPublicId('refund', refund.id),
      amount: amount(refund.amount),
      method: refund.method,
      reference: refund.reference,
      note: refund.note,
      refundedAt: refund.createdAt,
    })),
    calls: calls.map((call) => ({
      calledAt: toDate(call.created_at),
      outcome: call.outcome,
      callBackAt: toDateOrNull(call.call_back_at),
      note: call.note,
    })),
    transferReceipts: receipts.map((receipt) => ({
      id: toPublicId('transferReceipt', receipt.id),
      uploadedAt: toDate(receipt.created_at),
      contentType: receipt.content_type,
      bytes: receipt.size,
    })),
  };
}

function exportedDraft(draft: DraftOrderRecord) {
  const amount = amountIn(draft.currency);
  return {
    id: toPublicId('draftOrder', draft.id),
    name: draftName(draft.number),
    createdAt: draft.createdAt,
    status: draft.status,
    orderId: draft.orderId && toPublicId('order', draft.orderId),
    completedAt: draft.completedAt,
    paymentMethod: draft.paymentMethod,
    currency: draft.currency,
    lineItems: draft.lines.map((line) => ({
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: amount(line.unitPrice),
      total: amount(line.total),
    })),
    subtotal: amount(draft.subtotal),
    discount: amount(draft.discount),
    shipping: amount(draft.shipping),
    total: amount(draft.total),
    advancePaid: amount(draft.advancePaid),
    phone: draft.phone,
    email: draft.email,
    shippingAddress: exportedAddress(draft.shippingAddress),
    note: draft.note,
    tags: draft.tags,
  };
}

/** Adds orders to merges, erasure and exports when the application starts. */
@Injectable()
export class OrderCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(ORDER_CUSTOMER_DATA);
  }
}

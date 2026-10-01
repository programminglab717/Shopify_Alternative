import type { Actor } from '@hatti/api';
import { executePrepared, literalLimit, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import { searchKey } from '@hatti/pk';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type {
  FulfillmentRecord,
  OrderLineRecord,
  OrderRecord,
  ParcelClaimRecord,
  RefundRecord,
} from './records.js';
import {
  FIRST_ORDER_NUMBER,
  fulfillmentStatusOf,
  isFinalStage,
  orderLinkExpiry,
  stageOf,
  type ParcelSummary,
} from './rules.js';
import {
  orderEvents,
  orders,
  type ActorKind,
  type BankAccountValue,
  type OrderRow,
  type RiskLevelValue,
  type RiskReasonValue,
  type StoredAddressValue,
} from './schema.js';

interface OrderJsonRow extends Record<string, unknown> {
  id: string;
  number: number;
  source: OrderRecord['source'];
  status: OrderRecord['status'];
  confirmation_status: OrderRecord['confirmationStatus'];
  financial_status: OrderRecord['financialStatus'];
  fulfillment_status: OrderRecord['fulfillmentStatus'];
  stage: OrderRecord['stage'];
  payment_method: OrderRecord['paymentMethod'];
  currency: string;
  // int8 arrives as text, so no amount loses precision.
  subtotal: string;
  discount: string;
  shipping: string;
  cod_fee: string;
  tax_rate: number | null;
  total_tax: string;
  shipping_tax: string;
  transfer_discount: string;
  total: string;
  discount_codes: string[];
  amount_paid: string;
  amount_refunded: string;
  cod_amount: string;
  advance_due: string;
  bank_account: BankAccountValue | null;
  customer_id: string;
  phone: string | null;
  email: string | null;
  shipping_address: StoredAddressValue;
  customer_erased_at: string | null;
  location_id: string;
  note: string;
  tags: string[];
  cancel_reason: OrderRecord['cancelReason'];
  risk_score: number | null;
  risk_level: RiskLevelValue | null;
  risk_reasons: RiskReasonValue[];
  has_link: boolean;
  link_expires_at: string | null;
  agreed_policy_versions: string[] | null;
  agreed_at: string | null;
  client_ip: string | null;
  client_user_agent: string | null;
  confirmed_at: string | null;
  packed_at: string | null;
  cancelled_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  assignee_id: string | null;
  assigned_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  lines: {
    id: string;
    position: number;
    variant_id: string;
    product_id: string;
    title: string;
    variant_title: string;
    sku: string | null;
    quantity: number;
    unit_price: string;
    total: string;
    weight_grams: number | null;
    fulfilled_quantity: number;
    taxable: boolean;
    tax_rate: number | null;
    tax: string;
  }[];
  fulfillments: {
    id: string;
    status: FulfillmentRecord['status'];
    location_id: string;
    tracking_company: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    lines: { line_id: string; quantity: number; restocked_quantity: number | null }[];
    shipped_at: string;
    delivered_at: string | null;
    returning_at: string | null;
    returned_at: string | null;
    lost_at: string | null;
    courier_charges: string | null;
    claim_status: ParcelClaimRecord['status'] | null;
    claim_amount: string | null;
    claim_paid: string | null;
    claim_note: string | null;
    claimed_at: string | null;
    claim_settled_at: string | null;
    version: number;
    created_at: string;
    updated_at: string;
  }[];
  refunds: {
    id: string;
    amount: string;
    tax: string;
    method: RefundRecord['method'];
    reference: string | null;
    note: string;
    actor_kind: RefundRecord['actorKind'];
    actor_id: string;
    created_at: string;
  }[];
}

function toOrderRecord(row: OrderJsonRow): OrderRecord {
  return {
    id: row.id,
    number: row.number,
    source: row.source,
    status: row.status,
    confirmationStatus: row.confirmation_status,
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    stage: row.stage,
    paymentMethod: row.payment_method,
    currency: row.currency as CurrencyCode,
    subtotal: BigInt(row.subtotal),
    discount: BigInt(row.discount),
    shipping: BigInt(row.shipping),
    codFee: BigInt(row.cod_fee),
    taxRate: row.tax_rate,
    totalTax: BigInt(row.total_tax),
    shippingTax: BigInt(row.shipping_tax),
    transferDiscount: BigInt(row.transfer_discount),
    total: BigInt(row.total),
    discountCodes: row.discount_codes,
    amountPaid: BigInt(row.amount_paid),
    amountRefunded: BigInt(row.amount_refunded),
    codAmount: BigInt(row.cod_amount),
    advanceDue: BigInt(row.advance_due),
    // Orders placed before Raast IDs were kept have none.
    bankAccount: row.bank_account && {
      ...row.bank_account,
      raastId: row.bank_account.raastId ?? null,
    },
    customerId: row.customer_id,
    phone: row.phone,
    email: row.email,
    shippingAddress: row.shipping_address,
    customerErasedAt: toDateOrNull(row.customer_erased_at),
    locationId: row.location_id,
    note: row.note,
    tags: row.tags,
    cancelReason: row.cancel_reason,
    risk:
      row.risk_score === null || row.risk_level === null
        ? null
        : { score: row.risk_score, level: row.risk_level, reasons: row.risk_reasons },
    link: row.has_link
      ? {
          expiresAt: orderLinkExpiry({
            status: row.status,
            linkExpiresAt: toDateOrNull(row.link_expires_at),
            closedAt: toDateOrNull(row.closed_at),
            cancelledAt: toDateOrNull(row.cancelled_at),
          }),
        }
      : null,
    agreement: row.agreed_policy_versions
      ? {
          policyVersions: row.agreed_policy_versions,
          agreedAt: toDate(row.agreed_at!),
          ip: row.client_ip,
          userAgent: row.client_user_agent,
        }
      : null,
    confirmedAt: toDateOrNull(row.confirmed_at),
    packedAt: toDateOrNull(row.packed_at),
    cancelledAt: toDateOrNull(row.cancelled_at),
    paidAt: toDateOrNull(row.paid_at),
    closedAt: toDateOrNull(row.closed_at),
    assignee: row.assignee_id
      ? { staffMemberId: row.assignee_id, assignedAt: toDate(row.assigned_at!) }
      : null,
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lines: row.lines.map((line): OrderLineRecord => ({
      id: line.id,
      position: line.position,
      variantId: line.variant_id,
      productId: line.product_id,
      title: line.title,
      variantTitle: line.variant_title,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: BigInt(line.unit_price),
      total: BigInt(line.total),
      weightGrams: line.weight_grams,
      fulfilledQuantity: line.fulfilled_quantity,
      taxable: line.taxable,
      taxRate: line.tax_rate,
      tax: BigInt(line.tax),
    })),
    fulfillments: row.fulfillments.map((parcel): FulfillmentRecord => ({
      id: parcel.id,
      status: parcel.status,
      locationId: parcel.location_id,
      trackingCompany: parcel.tracking_company,
      trackingNumber: parcel.tracking_number,
      trackingUrl: parcel.tracking_url,
      lines: parcel.lines.map((line) => ({
        lineId: line.line_id,
        quantity: line.quantity,
        restockedQuantity: line.restocked_quantity,
      })),
      shippedAt: toDate(parcel.shipped_at),
      deliveredAt: toDateOrNull(parcel.delivered_at),
      returningAt: toDateOrNull(parcel.returning_at),
      returnedAt: toDateOrNull(parcel.returned_at),
      lostAt: toDateOrNull(parcel.lost_at),
      courierCharges: parcel.courier_charges === null ? null : BigInt(parcel.courier_charges),
      claim:
        parcel.claim_status === null
          ? null
          : {
              status: parcel.claim_status,
              amount: BigInt(parcel.claim_amount!),
              paid: parcel.claim_paid === null ? null : BigInt(parcel.claim_paid),
              note: parcel.claim_note,
              claimedAt: toDate(parcel.claimed_at!),
              settledAt: toDateOrNull(parcel.claim_settled_at),
            },
      version: parcel.version,
      createdAt: toDate(parcel.created_at),
      updatedAt: toDate(parcel.updated_at),
    })),
    refunds: row.refunds.map((refund): RefundRecord => ({
      id: refund.id,
      amount: BigInt(refund.amount),
      tax: BigInt(refund.tax),
      method: refund.method,
      reference: refund.reference,
      note: refund.note,
      actorKind: refund.actor_kind,
      actorId: refund.actor_id,
      createdAt: toDate(refund.created_at),
    })),
  };
}

/**
 * Orders with their lines, parcels and refunds, in one statement whatever the page size. Amounts travel as
 * text inside the JSON, which loses precision on numbers above 2^53. Prepared by name when
 * `prepared` says so (ADR-111): for an order by ID or IDs, and pages of the newest orders, or a
 * stage's, a customer's or a risk level's, whose plans are the same for every shop.
 */
export async function loadOrders(
  tx: Tx,
  shopId: string,
  options: { where?: SQL; order?: SQL; limit?: number; prepared?: boolean } = {},
): Promise<OrderRecord[]> {
  const query = sql`
    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions, o.agreed_at,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.assignee_id, o.assigned_at,
           o.version, o.created_at, o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND ${options.where ?? sql`true`}
     ORDER BY ${options.order ?? sql`o.id DESC`}
     ${options.limit === undefined ? sql`` : literalLimit(options.limit)}`;
  const { rows } = options.prepared
    ? await executePrepared<OrderJsonRow>(tx, query)
    : await tx.execute<OrderJsonRow>(query);
  return rows.map(toOrderRecord);
}

/** An order: its page, and what every change to it answers with. Prepared (ADR-111). */
export async function loadOrder(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const [order] = await loadOrders(tx, shopId, { where: sql`o.id = ${orderId}`, prepared: true });
  return order ?? null;
}

/** Locks an order for a change; state changes of one order happen one at a time. */
export async function lockOrder(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderRow | undefined> {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)))
    .for('update');
  return row;
}

/**
 * The shop's next order number. Take it last in the order's transaction: the counter row stays
 * locked until the transaction ends, and numbers taken by failed orders are given back.
 */
export async function nextOrderNumber(tx: Tx, shopId: string): Promise<number> {
  const { rows } = await tx.execute<{ number: number }>(sql`
    INSERT INTO orders.counters (shop_id, next_number)
    VALUES (${shopId}, ${FIRST_ORDER_NUMBER + 1})
        ON CONFLICT (shop_id) DO UPDATE SET next_number = orders.counters.next_number + 1
    RETURNING next_number - 1 AS number`);
  return rows[0]!.number;
}

/**
 * The shop's next draft order number, #D1 onwards. Take it last in the draft's transaction, as
 * order numbers are taken.
 */
export async function nextDraftNumber(tx: Tx, shopId: string): Promise<number> {
  const { rows } = await tx.execute<{ number: number }>(sql`
    INSERT INTO orders.counters (shop_id, next_number, next_draft_number)
    VALUES (${shopId}, ${FIRST_ORDER_NUMBER}, 2)
        ON CONFLICT (shop_id) DO UPDATE
       SET next_draft_number = orders.counters.next_draft_number + 1
    RETURNING next_draft_number - 1 AS number`);
  return rows[0]!.number;
}

/** What the order's search matches: the customer's name, city and email. */
export function searchTextOf(address: StoredAddressValue, email: string | null): string {
  return searchKey([address.name ?? '', address.city, email ?? ''].join(' '));
}

export function actorColumns(actor: Actor | 'system'): {
  actorKind: ActorKind;
  actorId: string | null;
} {
  if (actor === 'system') return { actorKind: 'system', actorId: null };
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/** Adds an entry to an order's timeline. */
export async function addTimelineEntry(
  tx: Tx,
  shopId: string,
  orderId: string,
  actor: Actor | 'system',
  kind: string,
  message: string,
): Promise<void> {
  await tx.insert(orderEvents).values({
    shopId,
    id: newId(),
    orderId,
    kind,
    message,
    ...actorColumns(actor),
  });
}

/** What the order's parcels add up to, as the transaction sees them now. */
export async function parcelSummary(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<ParcelSummary> {
  const { rows } = await tx.execute<ParcelSummary & Record<string, unknown>>(sql`
    SELECT (SELECT coalesce(sum(quantity), 0)::int FROM orders.lines
             WHERE shop_id = ${shopId} AND order_id = ${orderId}) AS units,
           (SELECT coalesce(sum(fulfilled_quantity), 0)::int FROM orders.lines
             WHERE shop_id = ${shopId} AND order_id = ${orderId}) AS shipped,
           count(*) FILTER (WHERE status = 'in_transit')::int AS "inTransit",
           count(*) FILTER (WHERE status = 'returning')::int AS returning,
           count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
           -- A parcel once lost stays lost to what it says of the order, even checked back in
           -- after it turned up: the courier lost it, the customer refused nothing.
           count(*) FILTER (WHERE status = 'returned' AND lost_at IS NULL)::int AS returned,
           count(*) FILTER (WHERE lost_at IS NOT NULL)::int AS lost
      FROM orders.fulfillments
     WHERE shop_id = ${shopId} AND order_id = ${orderId}`);
  return rows[0]!;
}

/** Timestamps an update can set to the transaction's time. */
export type OrderStamp =
  'confirmedAt' | 'packedAt' | 'cancelledAt' | 'paidAt' | 'closedAt' | 'agreedAt' | 'assignedAt';

type OrderChanges = Partial<
  Omit<OrderRow, 'shopId' | 'id' | 'stage' | 'fulfillmentStatus' | 'version' | 'updatedAt'>
>;

/**
 * Writes `changes` to a locked order and sets the `stamps` to now. Then it brings what follows
 * from the order and its parcels up to date: fulfillment status, stage, and closing the order once
 * it is done. A cash-on-delivery order whose every parcel came back unpaid is voided: no cash is
 * coming. Bumps the version, and returns the order as written.
 */
export async function updateOrder(
  tx: Tx,
  shopId: string,
  current: OrderRow,
  changes: OrderChanges,
  stamps: readonly OrderStamp[] = [],
): Promise<OrderRow> {
  // Stamps get the transaction's time below; for the stage, that they are set is what counts.
  const stamped = Object.fromEntries(stamps.map((stamp) => [stamp, new Date()]));
  const next = { ...current, ...changes, ...stamped };
  const parcels = await parcelSummary(tx, shopId, current.id);
  const stage = stageOf(next, parcels);
  const set: PgUpdateSetSource<typeof orders> = {
    ...changes,
    fulfillmentStatus: fulfillmentStatusOf(parcels),
    stage,
    version: sql`${orders.version} + 1`,
    updatedAt: sql`now()`,
  };
  const due = [...stamps];
  if (isFinalStage(stage) && next.status === 'open') {
    set.status = 'closed';
    due.push('closedAt');
  }
  if ((stage === 'returned' || stage === 'lost') && next.financialStatus === 'pending') {
    set.financialStatus = 'voided';
  }
  for (const stamp of due) set[stamp] = sql`now()`;
  const [updated] = await tx
    .update(orders)
    .set(set)
    .where(and(eq(orders.shopId, shopId), eq(orders.id, current.id)))
    .returning();
  return updated!;
}

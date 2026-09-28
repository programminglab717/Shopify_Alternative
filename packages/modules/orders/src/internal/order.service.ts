import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { LocationService, StockService, type LocationRecord } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { parsePkMobile, searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { checkAddress, checkEmail, checkTags, type AddressInput } from './address.js';
import {
  OrderEvents,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderUpdatedPayload,
} from './events.js';
import {
  addTimelineEntry,
  loadOrder,
  loadOrders,
  lockOrder,
  nextOrderNumber,
  searchTextOf,
  updateOrder,
} from './order-store.js';
import type { OrderEventRecord, OrderRecord, Page } from './records.js';
import { LIMITS, orderName, stageOf } from './rules.js';
import {
  ORDER_STAGES,
  lines,
  orderEvents,
  orders,
  type AddressValue,
  type CancelReasonValue,
  type OrderRow,
  type OrderSourceValue,
  type OrderStageValue,
  type PaymentMethodValue,
} from './schema.js';

export interface OrderLineInput {
  variantId: string;
  quantity: number;
  /** Replaces the variant's price, e.g. one agreed in chat. Decimal, in major units. */
  price?: string | null;
}

export interface OrderCreateInput {
  lineItems: OrderLineInput[];
  shippingAddress: AddressInput;
  email?: string | null;
  /** Cash on delivery unless given. */
  paymentMethod?: PaymentMethodValue | null;
  /** Paid in advance on a cash-on-delivery order, such as the delivery charge. */
  advancePaid?: string | null;
  shippingPrice?: string | null;
  discount?: string | null;
  /** Where it ships from, and where its stock is committed; the primary location if left out. */
  locationId?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

/** Fields left out stay as they are. */
export interface OrderUpdateInput {
  /** Replaces the whole address. Only before anything has shipped. */
  shippingAddress?: AddressInput | null;
  /** null clears it. */
  email?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

export interface ListOrdersOptions {
  first: number;
  after?: string | null;
  /**
   * An order number ("1001" or "#1001"), a mobile number in any format, a parcel's tracking
   * number, or words of the customer's name, city or email.
   */
  query?: string | null;
  stage?: OrderStageValue | null;
}

export interface CancelOptions {
  reason: CancelReasonValue;
  /** Why, for the timeline. */
  staffNote?: string | null;
}

const CANCEL_REASON_TEXT: Record<CancelReasonValue, string> = {
  customer: 'the customer cancelled',
  no_response: 'the customer could not be reached',
  fraud: 'the order looked fraudulent',
  inventory: 'the items were out of stock',
  other: 'other reasons',
};

/** Where an order shows in stock history: "hatti://orders/ord_…". */
function orderReference(orderId: string): string {
  return `hatti://orders/${toPublicId('order', orderId)}`;
}

/** The source of an order a caller creates directly: staff enter them, apps send them. */
function sourceOf(tenant: TenantContext): OrderSourceValue {
  return tenant.actor.kind === 'staff' ? 'manual' : 'api';
}

/**
 * Orders: placing them, confirming cash-on-delivery orders, cancelling, editing and recording
 * payment. Placing an order commits its stock at its location in the same transaction, so an order
 * exists only if its stock does; cancelling gives the stock back.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly stock: StockService,
  ) {}

  async create(
    tenant: TenantContext,
    input: OrderCreateInput,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const lineInputs = input.lineItems;
    if (lineInputs.length === 0)
      check.add(['input', 'lineItems'], 'BLANK', 'must include at least one');
    if (lineInputs.length > LIMITS.lines) {
      check.add(['input', 'lineItems'], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
    const checkedLines = lineInputs.map((line, index) => {
      const field = ['input', 'lineItems', String(index)];
      return {
        variantId: line.variantId,
        field,
        quantity: check.integer([...field, 'quantity'], line.quantity, {
          min: 1,
          max: LIMITS.quantity,
        }),
        price: check.price([...field, 'price'], line.price, tenant.currency),
      };
    });
    const address = checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
    const email = checkEmail(check, ['input', 'email'], input.email);
    const paymentMethod = input.paymentMethod ?? 'cash_on_delivery';
    const shipping =
      check.price(['input', 'shippingPrice'], input.shippingPrice, tenant.currency) ?? 0n;
    const discount = check.price(['input', 'discount'], input.discount, tenant.currency) ?? 0n;
    const advance = check.price(['input', 'advancePaid'], input.advancePaid, tenant.currency) ?? 0n;
    if (paymentMethod === 'prepaid' && advance > 0n) {
      check.addMessage(
        ['input', 'advancePaid'],
        'INVALID',
        'A prepaid order is paid in full; an advance is for cash-on-delivery orders',
      );
    }
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    const tags = checkTags(check, ['input', 'tags'], input.tags);
    if (!check.ok || !address) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<OrderRecord>> => {
      const snapshots = await this.variants.snapshotsOf(
        tx,
        tenant.shopId,
        checkedLines.map((line) => line.variantId),
      );
      const location = await this.#location(tx, tenant.shopId, input.locationId);
      const errors: FieldError[] = [];
      if (!location.ok) errors.push(location.error);
      for (const line of checkedLines) {
        const snapshot = snapshots.get(line.variantId);
        if (!snapshot) {
          errors.push({
            field: [...line.field, 'variantId'],
            code: 'NOT_FOUND',
            message: 'Variant not found',
          });
        } else if (snapshot.productStatus === 'archived') {
          errors.push({
            field: [...line.field, 'variantId'],
            code: 'INVALID',
            message: `"${snapshot.productTitle}" is archived, so it can't be sold`,
          });
        }
      }
      if (errors.length > 0 || !location.ok) return { ok: false, errors };

      const priced = checkedLines.map((line, index) => {
        const snapshot = snapshots.get(line.variantId)!;
        const unitPrice = line.price ?? snapshot.price;
        const quantity = line.quantity!;
        return { ...line, snapshot, quantity, unitPrice, position: index + 1 };
      });
      const subtotal = priced.reduce(
        (sum, line) => sum + line.unitPrice * BigInt(line.quantity),
        0n,
      );
      if (discount > subtotal) {
        return failOne(
          ['input', 'discount'],
          'INVALID',
          "The discount can't be more than the items cost",
        );
      }
      const total = subtotal - discount + shipping;
      if (advance > total) {
        return failOne(
          ['input', 'advancePaid'],
          'INVALID',
          "The advance can't be more than the total",
        );
      }
      const amountPaid = paymentMethod === 'prepaid' ? total : advance;

      // Stock first: an order exists only if its stock does.
      const orderId = newId();
      const committed = await this.stock.commit(
        tx,
        tenant,
        priced.map((line) => ({
          variantId: line.variantId,
          locationId: location.value.id,
          quantity: line.quantity,
        })),
        { referenceDocumentUri: orderReference(orderId) },
      );
      if (!committed.ok) {
        return {
          ok: false,
          errors: committed.shortages.map((shortage) => {
            const line = priced.find((candidate) => candidate.variantId === shortage.variantId)!;
            const left = Math.max(shortage.available, 0);
            return {
              field: [...line.field, 'quantity'],
              code: 'OUT_OF_STOCK',
              message:
                left === 0
                  ? `"${line.snapshot.productTitle}" is out of stock at ${location.value.name}`
                  : `Only ${left} of "${line.snapshot.productTitle}" left at ${location.value.name}`,
            };
          }),
        };
      }

      const statuses = {
        status: 'open' as const,
        confirmationStatus:
          paymentMethod === 'cash_on_delivery' ? ('pending' as const) : ('not_required' as const),
        financialStatus:
          amountPaid === total
            ? ('paid' as const)
            : amountPaid > 0n
              ? ('partially_paid' as const)
              : ('pending' as const),
        fulfillmentStatus: 'unfulfilled' as const,
      };
      const number = await nextOrderNumber(tx, tenant.shopId);
      const [row] = await tx
        .insert(orders)
        .values({
          shopId: tenant.shopId,
          id: orderId,
          number,
          source: sourceOf(tenant),
          ...statuses,
          stage: stageOf(statuses),
          paymentMethod,
          currency: tenant.currency,
          subtotal,
          discount,
          shipping,
          total,
          amountPaid,
          codAmount: paymentMethod === 'cash_on_delivery' ? total - amountPaid : 0n,
          phone: address.phone,
          email,
          shippingAddress: address,
          locationId: location.value.id,
          note,
          tags,
          searchText: searchTextOf(address, email),
          paidAt: amountPaid === total ? sql`now()` : null,
        })
        .returning();
      await tx.insert(lines).values(
        priced.map((line) => ({
          shopId: tenant.shopId,
          id: newId(),
          orderId,
          position: line.position,
          variantId: line.variantId,
          productId: line.snapshot.productId,
          title: line.snapshot.productTitle,
          variantTitle: line.snapshot.variantTitle,
          sku: line.snapshot.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.unitPrice * BigInt(line.quantity),
          weightGrams: line.snapshot.weightGrams,
        })),
      );
      const by = tenant.actor.kind === 'staff' ? 'by staff' : 'through the API';
      await addTimelineEntry(
        tx,
        tenant.shopId,
        orderId,
        tenant.actor,
        'created',
        `Order ${orderName(number)} placed ${by}: ${formatMoney(money(total, tenant.currency))}, ` +
          (paymentMethod === 'prepaid' ? 'paid in advance' : 'cash on delivery'),
      );
      await appendEvent<OrderCreatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderCreated,
        aggregateType: 'order',
        aggregateId: orderId,
        payload: {
          number,
          source: row!.source,
          paymentMethod,
          total: total.toString(),
          currency: tenant.currency,
          stage: row!.stage,
          version: row!.version,
        },
      });
      return { ok: true, value: (await loadOrder(tx, tenant.shopId, orderId))! };
    });
  }

  get(tenant: TenantContext, id: string): Promise<OrderRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => loadOrder(tx, tenant.shopId, id));
  }

  /** Orders, newest first. */
  async list(tenant: TenantContext, options: ListOrdersOptions): Promise<Page<OrderRecord>> {
    const conditions: SQL[] = [];
    if (options.after) conditions.push(sql`o.id < ${options.after}`);
    if (options.stage) conditions.push(sql`o.stage = ${options.stage}`);
    const query = options.query?.trim() ?? '';
    if (query !== '') {
      const mobile = parsePkMobile(query);
      // Every word must appear. Tokens hold only letters and digits, so no LIKE escaping.
      const words = searchKey(query)
        .split(' ')
        .filter(Boolean)
        .map((token) => sql`o.search_text LIKE ${`%${token}%`}`);
      const match = mobile
        ? sql`o.phone = ${mobile.e164}`
        : /^#?\d{1,9}$/.test(query)
          ? sql`o.number = ${Number(query.replace('#', ''))}`
          : words.length > 0
            ? sql.join(words, sql` AND `)
            : sql`false`;
      // A parcel's tracking number finds its order too.
      conditions.push(sql`(${match} OR EXISTS (
        SELECT 1 FROM orders.fulfillments f
         WHERE f.shop_id = o.shop_id AND f.order_id = o.id AND f.tracking_number = ${query}))`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await loadOrders(tx, tenant.shopId, {
        where: conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined,
        order: sql`o.id DESC`,
        limit: options.first + 1,
      });
      return { items: rows.slice(0, options.first), hasNextPage: rows.length > options.first };
    });
  }

  /** How many orders are at each stage, for the tabs of the order list. */
  async stageCounts(tenant: TenantContext): Promise<Map<OrderStageValue, number>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ stage: OrderStageValue; count: number }>(sql`
        SELECT stage, count(*)::int AS count FROM orders.orders
         WHERE shop_id = ${tenant.shopId} GROUP BY stage`);
      const counts = new Map<OrderStageValue, number>(ORDER_STAGES.map((stage) => [stage, 0]));
      for (const row of rows) counts.set(row.stage, row.count);
      return counts;
    });
  }

  /** The order's timeline, newest first. */
  async timeline(
    tenant: TenantContext,
    orderId: string,
    options: { first: number; after?: string | null },
  ): Promise<Page<OrderEventRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        order_id: string;
        kind: string;
        message: string;
        actor_kind: OrderEventRecord['actorKind'];
        actor_id: string | null;
        created_at: string;
      }>(sql`
        SELECT id, order_id, kind, message, actor_kind, actor_id, created_at
          FROM ${orderEvents}
         WHERE shop_id = ${tenant.shopId} AND order_id = ${orderId}
           ${options.after ? sql`AND id < ${options.after}` : sql``}
         ORDER BY id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map((row) => ({
          id: row.id,
          orderId: row.order_id,
          kind: row.kind,
          message: row.message,
          actorKind: row.actor_kind,
          actorId: row.actor_id,
          createdAt: toDate(row.created_at),
        })),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** Changes the shipping address, email, note or tags. */
  async update(
    tenant: TenantContext,
    id: string,
    input: OrderUpdateInput,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const address =
      input.shippingAddress === undefined || input.shippingAddress === null
        ? undefined
        : checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
    if (input.shippingAddress === null) {
      check.add(['input', 'shippingAddress'], 'BLANK', "can't be blank");
    }
    const email =
      input.email === undefined ? undefined : checkEmail(check, ['input', 'email'], input.email);
    const note =
      input.note === undefined
        ? undefined
        : (check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '');
    const tags =
      input.tags === undefined ? undefined : checkTags(check, ['input', 'tags'], input.tags);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(tenant, id, ['id'], async (tx, order) => {
      const changes: Partial<OrderRow> = {};
      const changed: string[] = [];
      if (address && !sameAddress(address, order.shippingAddress)) {
        if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
          return failOne(
            ['input', 'shippingAddress'],
            'INVALID',
            'The address can only change while nothing has shipped',
          );
        }
        changes.shippingAddress = address;
        changes.phone = address.phone;
        changed.push('shippingAddress');
      }
      if (email !== undefined && email !== order.email) {
        changes.email = email;
        changed.push('email');
      }
      if (note !== undefined && note !== order.note) {
        changes.note = note;
        changed.push('note');
      }
      if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(order.tags)) {
        changes.tags = tags;
        changed.push('tags');
      }
      if (changed.length === 0) return { ok: true, value: order };
      if (changes.shippingAddress || changes.email !== undefined) {
        changes.searchText = searchTextOf(
          changes.shippingAddress ?? order.shippingAddress,
          changes.email !== undefined ? changes.email : order.email,
        );
      }
      const updated = await updateOrder(tx, tenant.shopId, order, changes);
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'updated',
        `Changed the ${changed.map((name) => CHANGE_NAMES[name] ?? name).join(', ')}`,
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed, stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /** Records that the customer confirmed a cash-on-delivery order. */
  async confirm(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.status === 'cancelled') {
        return failOne(['id'], 'INVALID', "A cancelled order can't be confirmed");
      }
      if (order.confirmationStatus === 'confirmed' || order.confirmationStatus === 'not_required') {
        return { ok: true, value: order };
      }
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        { confirmationStatus: 'confirmed' },
        ['confirmedAt'],
      );
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'confirmed',
        'Confirmed by the customer',
      );
      await appendEvent<OrderConfirmedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderConfirmed,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Cancels an order that has not shipped, and releases its committed stock. Money already paid
   * is refunded outside Hatti for now.
   */
  async cancel(
    tenant: TenantContext,
    id: string,
    options: CancelOptions,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const staffNote = check.text(['staffNote'], options.staffNote, { max: LIMITS.note });
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.status === 'cancelled') return { ok: true, value: order };
      if (order.status === 'closed' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(['id'], 'INVALID', "An order that has shipped can't be cancelled");
      }
      const orderLines = await tx
        .select({ variantId: lines.variantId, quantity: lines.quantity })
        .from(lines)
        .where(and(eq(lines.shopId, tenant.shopId), eq(lines.orderId, order.id)));
      const released = await this.stock.releaseCommitment(
        tx,
        tenant,
        orderLines.map((line) => ({ ...line, locationId: order.locationId })),
        { referenceDocumentUri: orderReference(order.id) },
      );
      if (!released.ok) throw new Error('Releasing stock cannot fall short');

      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        { status: 'cancelled', cancelReason: options.reason },
        ['cancelledAt'],
      );
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'cancelled',
        `Cancelled because ${CANCEL_REASON_TEXT[options.reason]}` +
          (staffNote ? `: ${staffNote}` : ''),
      );
      await appendEvent<OrderCancelledPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderCancelled,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { reason: options.reason, stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /** Records that the order is paid in full: cash collected at the door, or a transfer received. */
  async markAsPaid(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.financialStatus === 'paid') return { ok: true, value: order };
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
      }
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        { financialStatus: 'paid', amountPaid: order.total },
        ['paidAt'],
      );
      const received = formatMoney(
        money(order.total - order.amountPaid, order.currency as CurrencyCode),
      );
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'paid',
        `Marked as paid: ${received} received`,
      );
      await appendEvent<OrderPaidPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderPaid,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          amountPaid: order.total.toString(),
          stage: updated.stage,
          version: updated.version,
        },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Runs `change` on the locked order in one transaction and returns the order as it ends up.
   * `change` returns user errors, or the order row to report.
   */
  async #change(
    tenant: TenantContext,
    id: string,
    idField: string[],
    change: (tx: Tx, order: OrderRow) => Promise<MutationResult<OrderRow>>,
  ): Promise<MutationResult<OrderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const order = await lockOrder(tx, tenant.shopId, id);
      if (!order) return failOne(idField, 'NOT_FOUND', 'Order not found');
      const result = await change(tx, order);
      if (!result.ok) return result;
      return { ok: true, value: (await loadOrder(tx, tenant.shopId, id))! };
    });
  }

  /** The location named, which must be active; or the primary location. */
  async #location(
    tx: Tx,
    shopId: string,
    locationId: string | null | undefined,
  ): Promise<{ ok: true; value: LocationRecord } | { ok: false; error: FieldError }> {
    if (!locationId) return { ok: true, value: await this.locations.primaryOf(tx, shopId) };
    const location = (await this.locations.locationsOf(tx, shopId, [locationId])).get(locationId);
    if (!location) {
      return {
        ok: false,
        error: { field: ['input', 'locationId'], code: 'NOT_FOUND', message: 'Location not found' },
      };
    }
    if (!location.isActive) {
      return {
        ok: false,
        error: {
          field: ['input', 'locationId'],
          code: 'INVALID',
          message: 'The location is not active',
        },
      };
    }
    return { ok: true, value: location };
  }
}

/** Field by field: Postgres returns jsonb objects with their keys reordered. */
function sameAddress(a: AddressValue, b: AddressValue): boolean {
  return (Object.keys(a) as (keyof AddressValue)[]).every((key) => a[key] === (b[key] ?? null));
}

const CHANGE_NAMES: Record<string, string> = {
  shippingAddress: 'shipping address',
  email: 'email',
  note: 'note',
  tags: 'tags',
};

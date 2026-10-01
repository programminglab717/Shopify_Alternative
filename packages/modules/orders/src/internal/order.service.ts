import { isIP } from 'node:net';
import {
  INPUT_LIMITS,
  InputChecker,
  actorColumnsOf,
  failOne,
  type Actor,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import {
  BlocklistService,
  CustomerService,
  blockReasonText,
  type BlocklistEntryRecord,
} from '@hatti/customers/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { LocationService, StockService, type LocationRecord } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { orderTaxOf, taxSettingsIn } from '@hatti/tax/public';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { checkAddress, type AddressInput } from './address.js';
import { bankTransferSettingsIn } from './bank-transfer.service.js';
import { customerFactsQuery } from './customer-facts.js';
import {
  OrderEvents,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderUpdatedPayload,
} from './events.js';
import { orderConditions, type OrderFilter } from './order-filter.js';
import { UNREACHABLE_LIMITS } from './order-settings.service.js';
import { assessOrderRisk } from './order-risk.js';
import {
  addTimelineEntry,
  loadOrder,
  loadOrders,
  lockOrder,
  nextOrderNumber,
  parcelSummary,
  searchTextOf,
  updateOrder,
} from './order-store.js';
import { parcelWorth } from './parcel-claims.js';
import type {
  CustomerOrderStats,
  OrderEventRecord,
  OrderHome,
  OrderRecord,
  OrderTally,
  Page,
} from './records.js';
import {
  advanceForRiskMessage,
  heldForRiskMessage,
  holdsForRisk,
  type RiskAssessment,
} from './risk.js';
import {
  LIMITS,
  advanceRefusal,
  codLimitError,
  orderName,
  stageOf,
  transferOwed,
} from './rules.js';
import {
  ORDER_STAGES,
  lines,
  orderEvents,
  orders,
  type AddressValue,
  type CancelReasonValue,
  type ConfirmationStatusValue,
  type OrderRow,
  type OrderSourceValue,
  type OrderStageValue,
  type PaymentMethodValue,
  type StoredAddressValue,
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
  /**
   * Asked for in advance on a cash-on-delivery order, by transfer to the shop's account, before it
   * ships (ADR-083): it waits for it, and the courier collects the rest.
   */
  advanceDue?: string | null;
  shippingPrice?: string | null;
  discount?: string | null;
  /** Where it ships from, and where its stock is committed; the primary location if left out. */
  locationId?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

/** An order to place, checked: an orderCreate's, or a draft's items at the prices agreed. */
export interface OrderToPlace {
  /** Where its fields are in the request, for errors: ["input"] for orderCreate's. */
  field: string[];
  lines: {
    variantId: string;
    quantity: number;
    /** Replaces the variant's price; minor units. */
    price: bigint | null;
  }[];
  address: AddressValue;
  email: string | null;
  paymentMethod: PaymentMethodValue;
  /** Minor units. */
  shipping: bigint;
  discount: bigint;
  /** Paid in advance already. */
  advance: bigint;
  /**
   * Asked for in advance, by transfer, before it ships (ADR-083); cash on delivery only, and not
   * with `advance`.
   */
  advanceDue?: bigint;
  /**
   * Asked for in advance only if the shop's risk rules score the order `from` (1 to 100) or more
   * as it is placed, instead of holding it for review (ADR-094); cash on delivery only, and not
   * with `advance` or `advanceDue`.
   */
  riskAdvance?: { due: bigint; from: number } | null;
  /** What it charges for paying on delivery, as checkout adds it (CHK-08); cash on delivery only. */
  codFee?: bigint;
  /**
   * Of `discount`, what is taken off for paying by bank transfer, as checkout takes it (CHK-08,
   * ADR-077); bank transfer only.
   */
  transferDiscount?: bigint;
  /** Where it ships from; the primary location if null. */
  locationId: string | null;
  note: string;
  tags: string[];
  /** What its customer agreed to, when they place it themselves through checkout (ADR-057). */
  agreement?: OrderAgreementInput | null;
  /**
   * The discount codes `discount` and `shipping` take account of, as the shop wrote them;
   * counting their uses is the caller's.
   */
  discountCodes?: string[];
}

/** An order's e-contract log, as checkout gives it (ADR-057). */
export interface OrderAgreementInput {
  /** The versions of the shop's policies the page linked; none when it had none. */
  policyVersions: string[];
  /** The customer's address and browser, as Shopify's client details; kept only if well formed. */
  ip: string | null;
  userAgent: string | null;
}

/** Who places an order for which shop, and how, for its source and timeline. */
export interface Placement {
  shopId: string;
  currency: CurrencyCode;
  /**
   * Who to record in the timeline and stock history: the caller, or Hatti itself when a customer
   * confirms a draft through its link.
   */
  actor: Actor | 'system';
  source: OrderSourceValue;
  /** How the timeline says it was placed: "by staff", or "from draft #D2 by staff". */
  how: string;
  /** Set when the customer confirmed it already, through a draft's link. */
  confirmedByCustomer?: boolean;
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

/** An update's values, checked; those left out stay as they are. */
export interface CheckedOrderUpdate {
  address?: AddressValue;
  email?: string | null;
  note?: string;
  tags?: string[];
}

export interface ListOrdersOptions extends OrderFilter {
  first: number;
  after?: string | null;
}

export interface CancelOptions {
  reason: CancelReasonValue;
  /** Why, for the timeline. */
  staffNote?: string | null;
}

/** What a bulk action did: the orders now as asked, and why the others are not. */
export interface BulkResult {
  /** In the order given; orders that failed are left out. */
  orders: OrderRecord[];
  /** One or more per order that failed, at its place in the IDs: ["ids", "3"]. */
  errors: FieldError[];
}

/** How the timeline says an order is paid. */
const PAYMENT_METHOD_TEXT: Record<PaymentMethodValue, string> = {
  cash_on_delivery: 'cash on delivery',
  prepaid: 'paid in advance',
  bank_transfer: 'by bank transfer',
};

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

/**
 * Why an order from a blocked number waits for review, for its timeline. Timeline messages hold no
 * contact details, so erasing a customer leaves them as they are.
 */
function heldMessage(entry: BlocklistEntryRecord): string {
  return (
    `Held for review: the number is on the blocklist for ${blockReasonText(entry.reason)}` +
    (entry.note ? ` (${entry.note})` : '')
  );
}

/** The source of an order a caller creates directly: staff enter them, apps send them. */
function sourceOf(tenant: TenantContext): OrderSourceValue {
  return tenant.actor.kind === 'staff' ? 'manual' : 'api';
}

/**
 * Orders: placing them, confirming cash-on-delivery orders, cancelling, editing and recording
 * payment. Placing an order commits its stock at its location in the same transaction, so an order
 * exists only if its stock does; cancelling gives the stock back. Every order belongs to the
 * customer with its mobile number, and waits for review if the number is on the blocklist.
 * Cash-on-delivery orders are scored for how likely they are to come back unpaid, and wait for
 * review at the shop's threshold; bank-transfer orders wait for their money (ADR-074).
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly stock: StockService,
    private readonly customers: CustomerService,
    private readonly blocklist: BlocklistService,
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
        quantity: check.integer([...field, 'quantity'], line.quantity, {
          min: 1,
          max: LIMITS.quantity,
        }),
        price: check.price([...field, 'price'], line.price, tenant.currency),
      };
    });
    const address = checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
    const email = check.email(['input', 'email'], input.email);
    const paymentMethod = input.paymentMethod ?? 'cash_on_delivery';
    const shipping =
      check.price(['input', 'shippingPrice'], input.shippingPrice, tenant.currency) ?? 0n;
    const discount = check.price(['input', 'discount'], input.discount, tenant.currency) ?? 0n;
    const advance = check.price(['input', 'advancePaid'], input.advancePaid, tenant.currency) ?? 0n;
    const advanceDue =
      check.price(['input', 'advanceDue'], input.advanceDue, tenant.currency) ?? 0n;
    const noAdvance = advanceRefusal(paymentMethod);
    if (noAdvance && advance > 0n) {
      check.addMessage(['input', 'advancePaid'], 'INVALID', noAdvance);
    }
    if (noAdvance && advanceDue > 0n) {
      check.addMessage(['input', 'advanceDue'], 'INVALID', noAdvance);
    } else if (advance > 0n && advanceDue > 0n) {
      check.addMessage(
        ['input', 'advanceDue'],
        'INVALID',
        'Ask for an advance, or give the one paid already: not both',
      );
    }
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    const tags = check.tags(['input', 'tags'], input.tags);
    if (!check.ok || !address) return { ok: false, errors: check.errors };

    const order: OrderToPlace = {
      field: ['input'],
      lines: checkedLines.map((line) => ({ ...line, quantity: line.quantity! })),
      address,
      email,
      paymentMethod,
      shipping,
      discount,
      advance,
      advanceDue,
      locationId: input.locationId ?? null,
      note,
      tags,
    };
    const placement: Placement = {
      shopId: tenant.shopId,
      currency: tenant.currency,
      actor: tenant.actor,
      source: sourceOf(tenant),
      how: tenant.actor.kind === 'staff' ? 'by staff' : 'through the API',
    };
    return this.db.tenant(tenant.shopId, (tx) => this.placeIn(tx, placement, order));
  }

  /**
   * Places a checked order in the caller's transaction, as {@link create} describes: drafts are
   * placed through it too, at the prices agreed. Nothing is written when it returns errors.
   */
  async placeIn(
    tx: Tx,
    placement: Placement,
    order: OrderToPlace,
  ): Promise<MutationResult<OrderRecord>> {
    const { shopId, currency } = placement;
    const { address, email, paymentMethod, shipping, discount, advance } = order;
    const askedAhead = order.advanceDue ?? 0n;
    const riskAdvance = order.riskAdvance ?? null;
    if (
      (askedAhead > 0n || riskAdvance) &&
      (paymentMethod !== 'cash_on_delivery' || advance > 0n)
    ) {
      throw new Error('Only a cash-on-delivery order with nothing paid asks for an advance');
    }
    if (askedAhead > 0n && riskAdvance) {
      throw new Error('An order asks for an advance whatever its risk, or by it: not both');
    }
    const lineField = (index: number) => [...order.field, 'lineItems', String(index)];
    const snapshots = await this.variants.snapshotsOf(
      tx,
      shopId,
      order.lines.map((line) => line.variantId),
    );
    const location = await this.#location(tx, shopId, order.locationId, [
      ...order.field,
      'locationId',
    ]);
    const errors: FieldError[] = [];
    if (!location.ok) errors.push(location.error);
    order.lines.forEach((line, index) => {
      const snapshot = snapshots.get(line.variantId);
      if (!snapshot) {
        errors.push({
          field: [...lineField(index), 'variantId'],
          code: 'NOT_FOUND',
          message: 'Variant not found',
        });
      } else if (snapshot.productStatus === 'archived') {
        errors.push({
          field: [...lineField(index), 'variantId'],
          code: 'INVALID',
          message: `"${snapshot.productTitle}" is archived, so it can't be sold`,
        });
      }
    });
    if (errors.length > 0 || !location.ok) return { ok: false, errors };

    const priced = order.lines.map((line, index) => {
      const snapshot = snapshots.get(line.variantId)!;
      const unitPrice = line.price ?? snapshot.price;
      return { ...line, field: lineField(index), snapshot, unitPrice, position: index + 1 };
    });
    const subtotal = priced.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n);
    if (discount > subtotal) {
      return failOne(
        [...order.field, 'discount'],
        'INVALID',
        "The discount can't be more than the items cost",
      );
    }
    const codFee = order.codFee ?? 0n;
    if (codFee > 0n && paymentMethod !== 'cash_on_delivery') {
      throw new Error('Only an order paid on delivery has a fee for it');
    }
    const transferDiscount = order.transferDiscount ?? 0n;
    if (transferDiscount > 0n && paymentMethod !== 'bank_transfer') {
      throw new Error('Only an order paid by bank transfer has a discount for it');
    }
    if (transferDiscount > discount) {
      throw new Error("The discount for paying by transfer is part of the order's discount");
    }
    const total = subtotal - discount + shipping + codFee;
    // The sales tax its prices include, at the shop's rates now (ADR-096, ADR-097): on what was
    // paid for each line, after its share of the discount, at its tax code's rate or the shop's,
    // and on its charges where the shop's include it.
    const tax = orderTaxOf(await taxSettingsIn(tx, shopId), {
      lines: priced.map((line) => ({
        total: line.unitPrice * BigInt(line.quantity),
        taxable: line.snapshot.taxable,
        taxCode: line.snapshot.taxCode,
      })),
      discount,
      charges: shipping + codFee,
    });
    if (advance > total || askedAhead > total || (riskAdvance?.due ?? 0n) > total) {
      return failOne(
        [...order.field, advance > total ? 'advancePaid' : 'advanceDue'],
        'INVALID',
        "The advance can't be more than the total",
      );
    }
    // Cash at the door is what the advance, paid or asked for, leaves; one asked by the order's
    // risk may not be, so the cash is all of it.
    const overLimit = codLimitError(
      [...order.field, askedAhead > 0n ? 'advanceDue' : 'advancePaid'],
      {
        paymentMethod,
        currency,
        total,
        advance: advance + askedAhead,
      },
    );
    if (overLimit) return { ok: false, errors: [overLimit] };
    const amountPaid = paymentMethod === 'prepaid' ? total : advance;
    // The account its customer is told to pay into, the order or its advance, as it is now: a
    // later change of account leaves what they were told as it was.
    const account =
      paymentMethod === 'bank_transfer' || askedAhead > 0n || riskAdvance
        ? (await bankTransferSettingsIn(tx, shopId)).account
        : null;
    if ((askedAhead > 0n || riskAdvance) && !account) {
      return failOne(
        [...order.field, 'advanceDue'],
        'INVALID',
        "Asking for an advance needs the shop's bank account, which its customer pays it into",
      );
    }

    // Stock first: an order exists only if its stock does.
    const orderId = newId();
    const committed = await this.stock.commit(
      tx,
      { shopId, actor: placement.actor },
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

    // Then its customer, and whether the number is blocked. Customers come after stock in
    // every transaction that touches both, so that none waits on another in a cycle.
    const customerId = await this.customers.findOrCreate(tx, shopId, {
      phone: address.phone,
      name: address.name,
      email,
    });
    const blocked = await this.blocklist.entryOf(tx, shopId, address.phone);
    // An advance paid by transfer is the customer's say-so, as paying is: nothing to score.
    const scored =
      paymentMethod === 'cash_on_delivery' && askedAhead === 0n
        ? await assessOrderRisk(tx, shopId, {
            orderId,
            customerId,
            total,
            currency,
            units: priced.reduce((sum, line) => sum + line.quantity, 0),
            address,
          })
        : null;
    const risk = scored?.assessment ?? null;
    // An order scored as high as the shop's advance says is asked for it, instead of being held
    // for review (ADR-094); it keeps its score, which says why.
    const askedForRisk =
      riskAdvance !== null && risk !== null && risk.score >= riskAdvance.from
        ? riskAdvance.due
        : 0n;
    const advanceDue = askedAhead + askedForRisk;
    const bankAccount = paymentMethod === 'bank_transfer' || advanceDue > 0n ? account : null;
    const risky =
      scored !== null &&
      askedForRisk === 0n &&
      holdsForRisk(scored.settings, scored.assessment.score);
    // Paying, before or by transfer, is the customer's say-so, and so is an advance: only cash on
    // delivery without one is confirmed.
    const confirmationStatus: ConfirmationStatusValue =
      blocked || risky
        ? 'needs_review'
        : paymentMethod !== 'cash_on_delivery' || advanceDue > 0n
          ? 'not_required'
          : placement.confirmedByCustomer
            ? 'confirmed'
            : 'pending';

    const statuses = {
      status: 'open' as const,
      packedAt: null,
      confirmationStatus,
      financialStatus:
        amountPaid === total
          ? ('paid' as const)
          : amountPaid > 0n
            ? ('partially_paid' as const)
            : ('pending' as const),
      fulfillmentStatus: 'unfulfilled' as const,
    };
    const number = await nextOrderNumber(tx, shopId);
    const [row] = await tx
      .insert(orders)
      .values({
        shopId,
        id: orderId,
        number,
        source: placement.source,
        ...statuses,
        stage: stageOf({ ...statuses, paymentMethod, amountPaid, total, advanceDue }),
        paymentMethod,
        currency,
        subtotal,
        discount,
        shipping,
        codFee,
        taxRate: tax.rate,
        totalTax: tax.total,
        shippingTax: tax.charges,
        transferDiscount,
        total,
        amountPaid,
        codAmount: paymentMethod === 'cash_on_delivery' ? total - amountPaid - advanceDue : 0n,
        advanceDue,
        bankAccount,
        ...riskColumns(risk),
        customerId,
        phone: address.phone,
        email,
        shippingAddress: address,
        locationId: location.value.id,
        note: order.note,
        tags: order.tags,
        searchText: searchTextOf(address, email),
        discountCodes: order.discountCodes ?? [],
        confirmedAt: confirmationStatus === 'confirmed' ? sql`now()` : null,
        paidAt: amountPaid === total ? sql`now()` : null,
        ...agreementColumns(order.agreement ?? null),
      })
      .returning();
    await tx.insert(lines).values(
      priced.map((line, index) => ({
        shopId,
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
        taxable: line.snapshot.taxable,
        taxRate: tax.lines[index]!.rate,
        tax: tax.lines[index]!.tax,
      })),
    );
    await addTimelineEntry(
      tx,
      shopId,
      orderId,
      placement.actor,
      'created',
      `Order ${orderName(number)} placed ${placement.how}: ${formatMoney(money(total, currency))}, ` +
        PAYMENT_METHOD_TEXT[paymentMethod],
    );
    if (blocked) {
      await addTimelineEntry(tx, shopId, orderId, 'system', 'held', heldMessage(blocked));
    } else if (risky) {
      await addTimelineEntry(tx, shopId, orderId, 'system', 'held', heldForRiskMessage(risk!));
    }
    if (askedForRisk > 0n) {
      await addTimelineEntry(
        tx,
        shopId,
        orderId,
        'system',
        'advance_asked',
        advanceForRiskMessage(risk!, formatMoney(money(askedForRisk, currency))),
      );
    }
    await appendEvent<OrderCreatedPayload>(tx, shopId, {
      type: OrderEvents.OrderCreated,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {
        number,
        customerId,
        source: row!.source,
        paymentMethod,
        total: total.toString(),
        currency,
        riskLevel: risk?.level ?? null,
        stage: row!.stage,
        version: row!.version,
      },
    });
    return { ok: true, value: (await loadOrder(tx, shopId, orderId))! };
  }

  get(tenant: TenantContext, id: string): Promise<OrderRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => loadOrder(tx, tenant.shopId, id));
  }

  /** An order of the shop's, in the caller's transaction `tx`: for checkout's thank-you page. */
  orderOf(tx: Tx, shopId: string, id: string): Promise<OrderRecord | null> {
    return loadOrder(tx, shopId, id);
  }

  /** Orders by ID, for a request's loader; those not found are left out. */
  async getMany(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, OrderRecord>> {
    if (ids.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await loadOrders(tx, tenant.shopId, {
        where: sql`o.id = ANY(${sql.param([...ids])}::uuid[])`,
        prepared: true,
      });
      return new Map(found.map((order) => [order.id, order]));
    });
  }

  /**
   * Orders, newest first. A page of the shop's newest orders, or of one stage's, customer's or
   * risk level's, is prepared (ADR-111): each has an index in that order, whatever the shop.
   * Searches, dates and filters together are planned each time.
   */
  async list(tenant: TenantContext, options: ListOrdersOptions): Promise<Page<OrderRecord>> {
    const conditions = orderConditions(options);
    const prepared =
      !options.query?.trim() &&
      !options.placedFrom &&
      !options.placedBefore &&
      (options.transferReceipt === undefined || options.transferReceipt === null) &&
      [options.stage, options.riskLevel, options.customerId].filter(Boolean).length <= 1;
    if (options.after) conditions.push(sql`o.id < ${options.after}`);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await loadOrders(tx, tenant.shopId, {
        where: conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined,
        order: sql`o.id DESC`,
        limit: options.first + 1,
        prepared,
      });
      return { items: rows.slice(0, options.first), hasNextPage: rows.length > options.first };
    });
  }

  /**
   * The customer's number on an order in full, for staff who see it masked; null once the
   * customer's details are erased. The audit log records that it was revealed, and to whom.
   */
  async revealPhone(tenant: TenantContext, id: string): Promise<MutationResult<string | null>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [order] = await tx
        .select({ number: orders.number, phone: orders.phone })
        .from(orders)
        .where(and(eq(orders.shopId, tenant.shopId), eq(orders.id, id)));
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      if (order.phone !== null) {
        await recordAudit(tx, tenant.shopId, {
          action: 'order.phone_revealed',
          subjectType: 'order',
          subjectId: id,
          ...actorColumnsOf(tenant.actor),
          details: { number: order.number },
        });
      }
      return { ok: true, value: order.phone };
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

  /**
   * What waits for the shop, for the admin's home (ANL-01): orders at the stages that need
   * something of staff, and the cash on delivery still to come, in one statement over the stage
   * index; and the parcels the courier lost, to claim and claimed (ADR-093), over the index of
   * those.
   */
  async home(tenant: TenantContext): Promise<OrderHome> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        stage: OrderStageValue;
        count: number;
        total: string;
        unpaid_count: number;
        unpaid: string;
        receipted_count: number;
        receipted: string;
      }>(sql`
        SELECT stage, count(*)::int AS count, coalesce(sum(total), 0)::text AS total,
               count(*) FILTER (WHERE payment_method = 'cash_on_delivery'
                                  AND amount_paid < total)::int AS unpaid_count,
               coalesce(sum(total - amount_paid) FILTER (
                 WHERE payment_method = 'cash_on_delivery' AND amount_paid < total), 0)::text
                 AS unpaid,
               count(*) FILTER (WHERE receipted)::int AS receipted_count,
               coalesce(sum(total) FILTER (WHERE receipted), 0)::text AS receipted
          FROM (SELECT o.*,
                       o.stage = 'awaiting_payment' AND EXISTS (
                         SELECT 1 FROM orders.transfer_receipts r
                          WHERE r.shop_id = o.shop_id AND r.order_id = o.id) AS receipted
                  FROM orders.orders o) o
         WHERE shop_id = ${tenant.shopId}
           AND stage IN ('needs_confirmation', 'needs_review', 'awaiting_payment', 'to_pack',
                         'to_book', 'partially_fulfilled', 'in_transit', 'returning',
                         'delivered')
         GROUP BY stage`);
      // Parcels the courier lost that are not claimed yet, at their worth; and the claims still
      // open, for those and for parcels that came back damaged (ADR-098).
      const { rows: lost } = await tx.execute<{
        unclaimed_count: number;
        unclaimed: string;
        open_count: number;
        open: string;
      }>(sql`
        SELECT count(*) FILTER (WHERE status = 'lost' AND claim_status IS NULL)::int
                 AS unclaimed_count,
               coalesce(sum(worth) FILTER (WHERE status = 'lost' AND claim_status IS NULL), 0)::text
                 AS unclaimed,
               count(*) FILTER (WHERE claim_status = 'open')::int AS open_count,
               coalesce(sum(claim_amount) FILTER (WHERE claim_status = 'open'), 0)::text AS open
          FROM (SELECT f.status, f.claim_status, f.claim_amount,
                       CASE WHEN f.claim_status IS NULL THEN ${parcelWorth(sql`f`)} END AS worth
                  FROM orders.fulfillments f
                 WHERE f.shop_id = ${tenant.shopId}
                   AND (f.status = 'lost' OR f.claim_status IS NOT NULL)) f`);
      const at = (stage: OrderStageValue): OrderTally => {
        const row = rows.find((each) => each.stage === stage);
        return { count: row?.count ?? 0, total: BigInt(row?.total ?? 0) };
      };
      // Cash still to come: on its way, or delivered and not yet paid for.
      const owing = rows.filter((row) =>
        ['partially_fulfilled', 'in_transit', 'delivered'].includes(row.stage),
      );
      return {
        toConfirm: at('needs_confirmation'),
        toReview: at('needs_review'),
        awaitingPayment: at('awaiting_payment'),
        transfersToCheck: {
          count: rows.reduce((sum, row) => sum + row.receipted_count, 0),
          total: rows.reduce((sum, row) => sum + BigInt(row.receipted), 0n),
        },
        toPack: at('to_pack'),
        toBook: at('to_book'),
        returning: at('returning'),
        lostToClaim: { count: lost[0]!.unclaimed_count, total: BigInt(lost[0]!.unclaimed) },
        claimsOpen: { count: lost[0]!.open_count, total: BigInt(lost[0]!.open) },
        cashToCollect: {
          count: owing.reduce((sum, row) => sum + row.unpaid_count, 0),
          total: owing.reduce((sum, row) => sum + BigInt(row.unpaid), 0n),
        },
      };
    });
  }

  /** What each customer's orders add up to. Customers without orders are left out. */
  async customerStats(
    tenant: TenantContext,
    customerIds: readonly string[],
  ): Promise<Map<string, CustomerOrderStats>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        customer_id: string;
        number_of_orders: number;
        amount_spent: string;
        delivered_orders: number;
        returned_orders: number;
        lost_orders: number;
        cancelled_orders: number;
        last_order_at: string;
      }>(customerFactsQuery(tenant.shopId, customerIds));
      return new Map(
        rows.map((row) => [
          row.customer_id,
          {
            count: row.number_of_orders,
            amountSpent: BigInt(row.amount_spent),
            delivered: row.delivered_orders,
            returned: row.returned_orders,
            lost: row.lost_orders,
            cancelled: row.cancelled_orders,
            inProgress:
              row.number_of_orders -
              row.delivered_orders -
              row.returned_orders -
              row.lost_orders -
              row.cancelled_orders,
            lastOrderAt: toDateOrNull(row.last_order_at),
          },
        ]),
      );
    });
  }

  /**
   * How many orders the customer with `phone` refused at the door or could not be delivered to
   * (`returned`), and how many the shop delivered to them, as their delivery history counts them,
   * by any of their numbers, in the caller's transaction: none for a number no customer has. For
   * checkout's rules on cash on delivery and their advance (CHK-07, ADR-089, ADR-094).
   */
  async deliveriesOf(
    tx: Tx,
    shopId: string,
    phone: string,
  ): Promise<{ refused: number; delivered: number }> {
    const customerId = await this.customers.idOf(tx, shopId, phone);
    if (!customerId) return { refused: 0, delivered: 0 };
    const { rows } = await tx.execute<{ returned_orders: number; delivered_orders: number }>(
      customerFactsQuery(shopId, [customerId]),
    );
    return { refused: rows[0]?.returned_orders ?? 0, delivered: rows[0]?.delivered_orders ?? 0 };
  }

  /**
   * How many orders checkout placed lately from where a new one comes from (CHK-18, ADR-087): to
   * its mobile number `phone` in the last day, and from its internet address `ip` in the last
   * hour, cancelled ones too; none from an address not known, or not an address, as orders keep
   * none then. In the caller's transaction, which holds a lock on the number, then on the
   * address, until it ends, so that orders from either are counted and placed one at a time.
   */
  async checkoutOrdersFrom(
    tx: Tx,
    shopId: string,
    from: { phone: string; ip: string | null },
  ): Promise<{ phoneDay: number; ipHour: number }> {
    const ip = from.ip && isIP(from.ip) !== 0 ? from.ip : null;
    const lock = (subject: string) =>
      tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${shopId}:${subject}`}, 0))`,
      );
    await lock(`phone:${from.phone}`);
    if (ip) await lock(`ip:${ip}`);
    const { rows } = await tx.execute<{ phone_day: number; ip_hour: number }>(sql`
      SELECT (SELECT count(*)::int
                FROM orders.orders
               WHERE shop_id = ${shopId} AND phone = ${from.phone} AND source = 'online_store'
                 AND created_at > now() - interval '1 day') AS phone_day,
             (SELECT count(*)::int
                FROM orders.orders
               WHERE shop_id = ${shopId} AND client_ip = ${ip}::inet
                 AND created_at > now() - interval '1 hour') AS ip_hour`);
    return { phoneDay: rows[0]!.phone_day, ipHour: rows[0]!.ip_hour };
  }

  /**
   * The different addresses each customer's orders went to, most recently used first: at most
   * `limit` per customer.
   */
  async customerAddresses(
    tenant: TenantContext,
    customerIds: readonly string[],
    limit: number,
  ): Promise<Map<string, AddressValue[]>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ customer_id: string; shipping_address: AddressValue }>(
        sql`
        SELECT customer_id, shipping_address
          FROM (SELECT customer_id, shipping_address, max(created_at) AS latest,
                       row_number() OVER (PARTITION BY customer_id
                                          ORDER BY max(created_at) DESC) AS rank
                  FROM orders.orders
                 WHERE shop_id = ${tenant.shopId}
                   AND customer_id = ANY(${sql.param([...customerIds])}::uuid[])
                 GROUP BY customer_id, shipping_address) used
         WHERE rank <= ${limit}
         ORDER BY customer_id, latest DESC`,
      );
      const addresses = new Map<string, AddressValue[]>();
      for (const row of rows) {
        const list = addresses.get(row.customer_id) ?? [];
        list.push(row.shipping_address);
        addresses.set(row.customer_id, list);
      }
      return addresses;
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
      input.email === undefined ? undefined : check.email(['input', 'email'], input.email);
    const note =
      input.note === undefined
        ? undefined
        : (check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '');
    const tags = input.tags === undefined ? undefined : check.tags(['input', 'tags'], input.tags);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(tenant, id, ['id'], (tx, order) =>
      this.updateLocked(
        tx,
        tenant.shopId,
        order,
        { address: address ?? undefined, email, note, tags },
        { actor: tenant.actor },
      ),
    );
  }

  /**
   * Changes an order locked in the caller's transaction, as {@link update} does, to values checked
   * already, with who did it for its timeline: the caller, or the customer through their link.
   * `message` words the timeline entry from what changed, "shipping address, note"; "Changed the
   * …" unless given. Errors name fields of orderUpdate's input.
   */
  async updateLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    values: CheckedOrderUpdate,
    by: { actor: Actor | 'system'; message?: (changed: string) => string },
  ): Promise<MutationResult<OrderRow>> {
    const { address, email, note, tags } = values;
    if (order.customerErasedAt && (email !== undefined || address)) {
      return failOne(
        ['input', email !== undefined ? 'email' : 'shippingAddress'],
        'INVALID',
        "The customer's details on this order were erased at their request",
      );
    }
    const changes: Partial<OrderRow> = {};
    const changed: string[] = [];
    let moved: AddressValue | null = null;
    if (address && !sameAddress(address, order.shippingAddress)) {
      if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(
          ['input', 'shippingAddress'],
          'INVALID',
          'The address can only change while nothing has shipped',
        );
      }
      moved = address;
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
    // A new number makes it the order of that number's customer, and may be a blocked one.
    let held: BlocklistEntryRecord | null = null;
    let heldForRisk: RiskAssessment | null = null;
    if (moved && moved.phone !== order.phone) {
      const customerId = await this.customers.findOrCreate(tx, shopId, {
        phone: moved.phone,
        name: moved.name,
        email: changes.email !== undefined ? changes.email : order.email,
      });
      if (customerId !== order.customerId) {
        changes.customerId = customerId;
        changed.push('customer');
      }
      const entry = await this.blocklist.entryOf(tx, shopId, moved.phone);
      if (entry && order.confirmationStatus !== 'needs_review') {
        changes.confirmationStatus = 'needs_review';
        held = entry;
      }
    }
    // A cash-on-delivery order is scored again for its new address. It waits for review if the
    // change is what makes it risky: staff who reviewed a risky order can still correct it.
    if (moved && order.paymentMethod === 'cash_on_delivery') {
      const { assessment, settings } = await assessOrderRisk(tx, shopId, {
        orderId: order.id,
        customerId: changes.customerId ?? order.customerId,
        total: order.total,
        currency: order.currency as CurrencyCode,
        units: (await parcelSummary(tx, shopId, order.id)).units,
        address: moved,
      });
      Object.assign(changes, riskColumns(assessment));
      const wasRisky = order.riskScore !== null && holdsForRisk(settings, order.riskScore);
      if (
        !wasRisky &&
        holdsForRisk(settings, assessment.score) &&
        order.confirmationStatus !== 'needs_review' &&
        !held
      ) {
        changes.confirmationStatus = 'needs_review';
        heldForRisk = assessment;
      }
    }
    const updated = await updateOrder(tx, shopId, order, changes);
    const names = changed.map((name) => CHANGE_NAMES[name] ?? name).join(', ');
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      by.actor,
      'updated',
      by.message ? by.message(names) : `Changed the ${names}`,
    );
    if (held) {
      await addTimelineEntry(tx, shopId, order.id, 'system', 'held', heldMessage(held));
    } else if (heldForRisk) {
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        'system',
        'held',
        heldForRiskMessage(heldForRisk),
      );
    }
    await appendEvent<OrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.OrderUpdated,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { changed, stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
  }

  /**
   * Records that the customer confirmed a cash-on-delivery order, or that staff reviewed an order
   * held for review and let it go ahead.
   */
  async confirm(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], (tx, order) =>
      this.confirmLocked(tx, tenant.shopId, order, {
        actor: tenant.actor,
        message:
          order.confirmationStatus === 'needs_review'
            ? 'Reviewed and confirmed'
            : 'Confirmed by the customer',
      }),
    );
  }

  /**
   * Confirms an order locked in the caller's transaction, as {@link confirm} does, with who did
   * it and how for its timeline. Confirming a confirmed order changes nothing.
   */
  async confirmLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    by: { actor: Actor | 'system'; message: string },
  ): Promise<MutationResult<OrderRow>> {
    if (order.status === 'cancelled') {
      return failOne(['id'], 'INVALID', "A cancelled order can't be confirmed");
    }
    if (order.confirmationStatus === 'confirmed' || order.confirmationStatus === 'not_required') {
      return { ok: true, value: order };
    }
    const updated = await updateOrder(tx, shopId, order, { confirmationStatus: 'confirmed' }, [
      'confirmedAt',
    ]);
    await addTimelineEntry(tx, shopId, order.id, by.actor, 'confirmed', by.message);
    await appendEvent<OrderConfirmedPayload>(tx, shopId, {
      type: OrderEvents.OrderConfirmed,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
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

    return this.#change(tenant, id, ['id'], (tx, order) =>
      this.cancelLocked(tx, tenant.shopId, order, {
        actor: tenant.actor,
        reason: options.reason,
        message:
          `Cancelled because ${CANCEL_REASON_TEXT[options.reason]}` +
          (staffNote ? `: ${staffNote}` : ''),
      }),
    );
  }

  /**
   * Cancels an order locked in the caller's transaction, as {@link cancel} does, with who did it
   * and how for its timeline. `declined` records that the customer turned it down when asked to
   * confirm it. Cancelling a cancelled order changes nothing.
   */
  async cancelLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    by: {
      actor: Actor | 'system';
      reason: CancelReasonValue;
      message: string;
      declined?: boolean;
    },
  ): Promise<MutationResult<OrderRow>> {
    if (order.status === 'cancelled') return { ok: true, value: order };
    if (order.status === 'closed' || order.fulfillmentStatus !== 'unfulfilled') {
      return failOne(['id'], 'INVALID', "An order that has shipped can't be cancelled");
    }
    const orderLines = await tx
      .select({ variantId: lines.variantId, quantity: lines.quantity })
      .from(lines)
      .where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
    const released = await this.stock.releaseCommitment(
      tx,
      { shopId, actor: by.actor },
      orderLines.map((line) => ({ ...line, locationId: order.locationId })),
      { referenceDocumentUri: orderReference(order.id) },
    );
    if (!released.ok) throw new Error('Releasing stock cannot fall short');

    const updated = await updateOrder(
      tx,
      shopId,
      order,
      {
        status: 'cancelled',
        cancelReason: by.reason,
        ...(by.declined ? { confirmationStatus: 'rejected' as const } : {}),
      },
      ['cancelledAt'],
    );
    await addTimelineEntry(tx, shopId, order.id, by.actor, 'cancelled', by.message);
    await appendEvent<OrderCancelledPayload>(tx, shopId, {
      type: OrderEvents.OrderCancelled,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { reason: by.reason, stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
  }

  /**
   * Cancels the shop's orders whose customers could not be reached (`no_response`, three calls
   * unanswered) and that still wait `days` days after they were placed (COD-05, ADR-092), the
   * oldest first and {@link UNREACHABLE_LIMITS.batch} at most: each in a transaction of its own,
   * by the system, its stock let go. An order answered or settled since it was found is left as
   * it is. How many it cancelled.
   */
  async cancelUnreachable(shopId: string, days: number, at: Date = new Date()): Promise<number> {
    const unreachable = and(
      eq(orders.shopId, shopId),
      eq(orders.status, 'open'),
      eq(orders.stage, 'needs_confirmation'),
      eq(orders.confirmationStatus, 'no_response'),
      lt(orders.createdAt, new Date(at.getTime() - days * 86_400_000)),
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(unreachable)
        .orderBy(asc(orders.createdAt))
        .limit(UNREACHABLE_LIMITS.batch),
    );
    let cancelled = 0;
    for (const { id } of found) {
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(unreachable, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        const result = await this.cancelLocked(tx, shopId, order, {
          actor: 'system',
          reason: 'no_response',
          message: `Cancelled: the customer could not be reached in ${days} ${days === 1 ? 'day' : 'days'}`,
        });
        return result.ok;
      });
      if (done) cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Marks a confirmed or paid order as packed, ready to hand to a courier: it moves from To pack to
   * To book. Shipping does not need it; it is for shops that pack and book in separate steps.
   */
  async markPacked(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      const refusal = packingRefusal(order);
      if (refusal) return failOne(['id'], 'INVALID', refusal);
      if (order.packedAt) return { ok: true, value: order };
      const updated = await updateOrder(tx, tenant.shopId, order, {}, ['packedAt']);
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'packed',
        'Marked as packed',
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['packed'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /** Takes back a packed mark, e.g. one made by mistake, while nothing has shipped. */
  async markUnpacked(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (!order.packedAt) return { ok: true, value: order };
      if (order.status === 'cancelled') {
        return failOne(['id'], 'INVALID', "A cancelled order can't be unpacked");
      }
      if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(['id'], 'INVALID', 'Only orders that have not shipped can be unpacked');
      }
      const updated = await updateOrder(tx, tenant.shopId, order, { packedAt: null });
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'unpacked',
        'Marked as not packed',
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['packed'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /** Confirms many orders; see {@link confirm}. */
  bulkConfirm(tenant: TenantContext, ids: readonly string[]): Promise<MutationResult<BulkResult>> {
    return this.#bulk(ids, (id) => this.confirm(tenant, id));
  }

  /** Cancels many orders, for one reason; see {@link cancel}. */
  bulkCancel(
    tenant: TenantContext,
    ids: readonly string[],
    options: CancelOptions,
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    check.text(['staffNote'], options.staffNote, { max: LIMITS.note });
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    return this.#bulk(ids, (id) => this.cancel(tenant, id, options));
  }

  /** Marks many orders packed; see {@link markPacked}. */
  bulkMarkPacked(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    return this.#bulk(ids, (id) => this.markPacked(tenant, id));
  }

  /** Adds tags to many orders; tags an order has already, in any case, are left as they are. */
  bulkAddTags(
    tenant: TenantContext,
    ids: readonly string[],
    tags: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    const added = check.tags(['tags'], [...tags]);
    if (added.length === 0) check.add(['tags'], 'BLANK', "can't be blank");
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    return this.#bulk(ids, (id) =>
      this.#retag(tenant, id, (current) => {
        const known = new Set(current.map((tag) => tag.toLowerCase()));
        const fresh = added.filter((tag) => !known.has(tag.toLowerCase()));
        return fresh.length === 0
          ? null
          : { tags: [...current, ...fresh], message: `Added ${tagList(fresh)}` };
      }),
    );
  }

  /** Removes tags from many orders, ignoring case. */
  bulkRemoveTags(
    tenant: TenantContext,
    ids: readonly string[],
    tags: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    const removed = check.tags(['tags'], [...tags]);
    if (removed.length === 0) check.add(['tags'], 'BLANK', "can't be blank");
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    const gone = new Set(removed.map((tag) => tag.toLowerCase()));
    return this.#bulk(ids, (id) =>
      this.#retag(tenant, id, (current) => {
        const kept = current.filter((tag) => !gone.has(tag.toLowerCase()));
        const dropped = current.filter((tag) => gone.has(tag.toLowerCase()));
        return dropped.length === 0 ? null : { tags: kept, message: `Removed ${tagList(dropped)}` };
      }),
    );
  }

  /**
   * Records that the order is paid in full: cash collected at the door, or a transfer received.
   * An order with refunds already, such as a returned advance, stays partially refunded.
   */
  async markAsPaid(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.amountPaid === order.total) return { ok: true, value: order };
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
      }
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        {
          financialStatus: order.amountRefunded > 0n ? 'partially_refunded' : 'paid',
          amountPaid: order.total,
        },
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
        `Marked as paid: ${received} received` +
          (order.paymentMethod === 'bank_transfer' ? ' by bank transfer' : ''),
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
   * Records money received for the order, by hand, as Shopify's `orderCreateManualPayment` does:
   * `amount` in the shop's currency, or, left out, what the order waits for by transfer (its
   * advance, or the rest of its total), else the rest. An order waiting for its advance or its
   * transfer moves on once that is in; one paid in full is marked paid.
   */
  async recordPayment(
    tenant: TenantContext,
    id: string,
    input: { amount?: string | null } = {},
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const given = check.price(['amount'], input.amount, tenant.currency);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
      }
      const rest = order.total - order.amountPaid;
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      if (rest <= 0n) return failOne(['id'], 'INVALID', 'The order is paid in full');
      const awaited = transferOwed(order);
      const amount = given ?? (awaited > 0n ? awaited : rest);
      if (amount <= 0n || amount > rest) {
        return failOne(['amount'], 'INVALID', `Give an amount up to the ${rupees(rest)} it owes`);
      }
      const paid = order.amountPaid + amount;
      const full = paid === order.total;
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        {
          amountPaid: paid,
          financialStatus: !full
            ? 'partially_paid'
            : order.amountRefunded > 0n
              ? 'partially_refunded'
              : 'paid',
        },
        full ? ['paidAt'] : [],
      );
      // Its advance, when this is what makes it up.
      const advance = order.advanceDue > 0n && order.amountPaid < order.advanceDue;
      const byTransfer = order.paymentMethod === 'bank_transfer' || advance;
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'paid',
        `Recorded a payment of ${rupees(amount)}` +
          (byTransfer ? ' by bank transfer' : '') +
          (advance && paid >= order.advanceDue ? ': the advance it asked for' : '') +
          (full ? ', paying it in full' : ''),
      );
      await appendEvent<OrderPaidPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderPaid,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { amountPaid: paid.toString(), stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Changes an order's tags as `retag` says, reading them under the order's lock so that two bulk
   * changes at once both count. `retag` returns null to leave them as they are.
   */
  async #retag(
    tenant: TenantContext,
    id: string,
    retag: (current: string[]) => { tags: string[]; message: string } | null,
  ): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      const next = retag(order.tags);
      if (!next) return { ok: true, value: order };
      if (next.tags.length > INPUT_LIMITS.tags) {
        return failOne(['id'], 'TOO_MANY', `An order can have at most ${INPUT_LIMITS.tags} tags`);
      }
      const updated = await updateOrder(tx, tenant.shopId, order, { tags: next.tags });
      await addTimelineEntry(tx, tenant.shopId, order.id, tenant.actor, 'updated', next.message);
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['tags'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Runs an action on each order in its own transaction, so one that fails leaves the others
   * done: a merchant confirming 37 orders gets 36 confirmed and one reason. IDs given twice count
   * once. Up to {@link LIMITS.batch} at a time.
   */
  async #bulk(
    ids: readonly string[],
    run: (id: string) => Promise<MutationResult<OrderRecord>>,
  ): Promise<MutationResult<BulkResult>> {
    if (ids.length === 0) return failOne(['ids'], 'BLANK', 'Ids must include at least one');
    if (ids.length > LIMITS.batch) {
      return failOne(['ids'], 'TOO_MANY', `Ids can have at most ${LIMITS.batch}`);
    }
    const result: BulkResult = { orders: [], errors: [] };
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const done = await run(id);
      if (done.ok) {
        result.orders.push(done.value);
      } else {
        for (const error of done.errors) {
          result.errors.push({ ...error, field: ['ids', String(index)] });
        }
      }
    }
    return { ok: true, value: result };
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
    locationId: string | null,
    field: string[],
  ): Promise<{ ok: true; value: LocationRecord } | { ok: false; error: FieldError }> {
    if (!locationId) return { ok: true, value: await this.locations.primaryOf(tx, shopId) };
    const location = (await this.locations.locationsOf(tx, shopId, [locationId])).get(locationId);
    if (!location) {
      return { ok: false, error: { field, code: 'NOT_FOUND', message: 'Location not found' } };
    }
    if (!location.isActive) {
      return {
        ok: false,
        error: { field, code: 'INVALID', message: 'The location is not active' },
      };
    }
    return { ok: true, value: location };
  }
}

/** An assessment as the order's columns; none for prepaid orders. */
function riskColumns(
  risk: RiskAssessment | null,
): Pick<OrderRow, 'riskScore' | 'riskLevel' | 'riskReasons'> {
  return {
    riskScore: risk?.score ?? null,
    riskLevel: risk?.level ?? null,
    riskReasons: risk?.reasons ?? [],
  };
}

/**
 * An e-contract log as the order's columns (ADR-057): the address only if it is one, since behind
 * a proxy it comes from a header anyone can fill in, and the browser's name without control
 * characters, cut to 512 characters.
 */
function agreementColumns(
  agreement: OrderAgreementInput | null,
): Pick<OrderRow, 'agreedPolicyVersions' | 'clientIp' | 'clientUserAgent'> {
  if (!agreement) return { agreedPolicyVersions: null, clientIp: null, clientUserAgent: null };
  return {
    agreedPolicyVersions: agreement.policyVersions,
    clientIp: agreement.ip && isIP(agreement.ip) !== 0 ? agreement.ip : null,
    clientUserAgent: agreement.userAgent?.replace(/\p{Cc}/gu, '').slice(0, 512) || null,
  };
}

/** Why an order cannot be packed, or null if it can. */
function packingRefusal(order: OrderRow): string | null {
  if (order.status === 'cancelled') return "A cancelled order can't be packed";
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return 'Only orders that have not shipped can be packed';
  }
  if (
    order.stage === 'needs_confirmation' ||
    order.stage === 'needs_review' ||
    order.stage === 'awaiting_payment'
  ) {
    return 'Only confirmed or paid orders can be packed';
  }
  return null;
}

/** "the tag eid" or "the tags eid, vip", for the timeline. */
function tagList(tags: readonly string[]): string {
  return `${tags.length === 1 ? 'the tag' : 'the tags'} ${tags.join(', ')}`;
}

/** Field by field: Postgres returns jsonb objects with their keys reordered. */
function sameAddress(a: AddressValue, b: StoredAddressValue): boolean {
  return (Object.keys(a) as (keyof AddressValue)[]).every((key) => a[key] === (b[key] ?? null));
}

const CHANGE_NAMES: Record<string, string> = {
  shippingAddress: 'shipping address',
  email: 'email',
  note: 'note',
  tags: 'tags',
  customer: 'customer',
};

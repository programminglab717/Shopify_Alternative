import {
  INPUT_LIMITS,
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService, type VariantSnapshot } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { LocationService, StockService, type StockLine } from '@hatti/inventory/public';
import { allocate, exponentOf, formatMoney, money, type CurrencyCode } from '@hatti/money';
import { orderTaxOf, taxSettingsIn } from '@hatti/tax/public';
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  OrderEvents,
  type OrderCancelledPayload,
  type OrderCreatedPayload,
  type OrderUpdatedPayload,
} from './events.js';
import type { OrderLineInput } from './order.service.js';
import { assessOrderRisk, riskColumns } from './order-risk.js';
import {
  addTimelineEntry,
  loadOrder,
  lockOrder,
  nextOrderNumber,
  orderReference,
  updateOrder,
  type OrderStamp,
} from './order-store.js';
import type { OrderRecord } from './records.js';
import { heldForRiskMessage, holdsForRisk, type RiskAssessment } from './risk.js';
import { COD_CASH_LIMIT, LIMITS, codLimitError, itemName, orderName, stageOf } from './rules.js';
import { lines, orders, type AddressValue, type LineRow, type OrderRow } from './schema.js';

/** A new quantity for one of an order's lines; 0 takes it off. */
export interface OrderLineQuantityInput {
  lineItemId: string;
  quantity: number;
}

/** What changes in an order's items (ORD-04); lines left out stay as they are. */
export interface OrderLineItemsEdit {
  setQuantities?: OrderLineQuantityInput[] | null;
  /** Variants to add, a line each, at their prices now unless a price is given. */
  addVariants?: OrderLineInput[] | null;
}

/** What an order charges for delivery and takes off its items, decimal; those left out stay. */
export interface OrderChargesEdit {
  shippingPrice?: string | null;
  discount?: string | null;
}

/** Units of one of an order's lines to send apart (ADR-135). */
export interface OrderSplitLineInput {
  lineItemId: string;
  quantity: number;
}

/** What of an order's items is sent apart, as an order of its own (ORD-04, ADR-135). */
export interface OrderSplitInput {
  lineItems: OrderSplitLineInput[];
  /** The part's delivery charge, decimal; nothing if left out, the shop sending it at its cost. */
  shippingPrice?: string | null;
}

/** A line as an edit leaves it: one of the order's, kept, or a variant added. */
interface EditedLine {
  id: string;
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  /** Minor units: a kept line's as it was sold. */
  unitPrice: bigint;
  /** What a unit cost the shop: a kept line's as it was sold, an added one's variant's now. */
  unitCost: bigint | null;
  weightGrams: number | null;
  taxable: boolean;
  /** Its variant's tax code now, for its rate; null when the variant is gone. */
  taxCode: string | null;
  /** A kept line's; null for a line added, which is new. */
  createdAt: Date | null;
  /** Where the edit names it, for errors; null for a kept line the edit leaves as it is. */
  field: string[] | null;
}

/** What an order's items become, and what follows from them, for an edit or a merge. */
interface Rewrite {
  /** Its lines before, in their order. */
  current: readonly LineRow[];
  /** Its lines after, in theirs. */
  edited: readonly EditedLine[];
  /** Its discount after, and of that what was taken off for paying by transfer. */
  discount: bigint;
  transferDiscount: bigint;
  /** Its delivery charge after. */
  shipping: bigint;
  /** Units to commit and to let go, at their locations, in one call. */
  stock: { commit: StockLine[]; release: StockLine[] };
  /** Where an error about its amounts is said; where a variant short of stock is. */
  field: string[];
  shortField: (variantId: string) => string[];
  /** Its other fields that change with it, such as a merged order's note. */
  also: Partial<OrderRow>;
  /** Its timeline entry, words from its total now and before when that changed. */
  kind: string;
  message: (totals: [now: string, was: string] | null) => string;
  /** What `order.updated` says changed. */
  changed: string[];
}

/** A rewrite's amounts, worked out and checked. */
interface Amounts {
  subtotal: bigint;
  total: bigint;
  codAmount: bigint;
  tax: ReturnType<typeof orderTaxOf>;
}

/**
 * Editing an order's items while it waits to be packed (ORD-04, ADR-131), as customers ask on the
 * confirmation call: a line's quantity changed or taken off, a variant added. Lines kept keep
 * their prices; a variant added comes at its price now, or one given. Its stock follows at its
 * location, its subtotal, total and sales tax are worked out again, and a cash-on-delivery order
 * collects the difference at the door. Its discount, delivery charge and fee stay as they are.
 */
@Injectable()
export class OrderEditService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly stock: StockService,
  ) {}

  /**
   * Changes the order's items as `edit` says, all or nothing. An edit that changes nothing
   * leaves the order as it is. Errors name fields of orderEditLineItems' input.
   */
  async editLineItems(
    tenant: TenantContext,
    id: string,
    edit: OrderLineItemsEdit,
  ): Promise<MutationResult<OrderRecord>> {
    const checked = checkEdit(tenant, edit);
    if (!checked.ok) return checked;
    const { quantities, additions } = checked.value;
    const { shopId } = tenant;

    return this.db.tenant(shopId, async (tx): Promise<MutationResult<OrderRecord>> => {
      const order = await lockOrder(tx, shopId, id);
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      const refusal = editRefusal(order);
      if (refusal) return failOne(['id'], 'INVALID', refusal);
      const current = await linesOf(tx, shopId, order.id);
      const lineIds = new Set(current.map((line) => line.id));
      const unknown = quantities.filter((entry) => !lineIds.has(entry.lineItemId));
      if (unknown.length > 0) {
        return {
          ok: false,
          errors: unknown.map((entry) => ({
            field: [...entry.field, 'lineItemId'],
            code: 'NOT_FOUND',
            message: 'Line item not found on this order',
          })),
        };
      }
      const asked = new Map(quantities.map((entry) => [entry.lineItemId, entry]));
      const unchanged = current.every(
        (line) => (asked.get(line.id)?.quantity ?? line.quantity) === line.quantity,
      );
      if (unchanged && additions.length === 0) {
        return { ok: true, value: (await loadOrder(tx, shopId, order.id))! };
      }

      const snapshots = await this.variants.snapshotsOf(tx, shopId, [
        ...current.map((line) => line.variantId),
        ...additions.map((line) => line.variantId),
      ]);
      const errors: FieldError[] = [];
      const edited: EditedLine[] = [];
      for (const line of current) {
        const entry = asked.get(line.id);
        const quantity = entry?.quantity ?? line.quantity;
        const snapshot = snapshots.get(line.variantId);
        // Selling more of it is selling it: a variant gone or archived sells no more.
        if (entry && quantity > line.quantity && notForSale(snapshot)) {
          errors.push({
            field: [...entry.field, 'quantity'],
            code: 'INVALID',
            message: snapshot
              ? `"${snapshot.productTitle}" is archived, so no more of it can be sold`
              : `"${itemName(line)}" was deleted, so no more of it can be sold`,
          });
        }
        if (quantity === 0) continue;
        edited.push({
          ...line,
          quantity,
          taxCode: snapshot?.taxCode ?? null,
          field: entry ? entry.field : null,
        });
      }
      const onOrder = new Set(current.map((line) => line.variantId));
      for (const line of additions) {
        const snapshot = snapshots.get(line.variantId);
        const field = [...line.field, 'variantId'];
        if (!snapshot) {
          errors.push({ field, code: 'NOT_FOUND', message: 'Variant not found' });
        } else if (notForSale(snapshot)) {
          errors.push({
            field,
            code: 'INVALID',
            message: `"${snapshot.productTitle}" is archived, so it can't be sold`,
          });
        } else if (onOrder.has(line.variantId)) {
          errors.push({
            field,
            code: 'INVALID',
            message:
              `"${itemName({ title: snapshot.productTitle, variantTitle: snapshot.variantTitle })}" ` +
              'is on the order already: change its quantity instead',
          });
        } else {
          edited.push({
            id: newId(),
            variantId: line.variantId,
            productId: snapshot.productId,
            title: snapshot.productTitle,
            variantTitle: snapshot.variantTitle,
            sku: snapshot.sku,
            quantity: line.quantity,
            unitPrice: line.price ?? snapshot.price,
            unitCost: snapshot.cost,
            weightGrams: snapshot.weightGrams,
            taxable: snapshot.taxable,
            taxCode: snapshot.taxCode,
            createdAt: null,
            field: line.field,
          });
        }
      }
      if (errors.length > 0) return { ok: false, errors };
      if (edited.length === 0) {
        return failOne(['input'], 'INVALID', 'An order keeps at least one item: cancel it instead');
      }
      if (edited.length > LIMITS.lines) {
        return failOne(
          ['input', 'addVariants'],
          'TOO_MANY',
          `An order can have at most ${LIMITS.lines} items`,
        );
      }

      // Its stock, at its location: units added committed, units taken off let go.
      const before = unitsByVariant(current);
      const after = unitsByVariant(edited);
      const commit: StockLine[] = [];
      const release: StockLine[] = [];
      for (const variantId of new Set([...before.keys(), ...after.keys()])) {
        const change = (after.get(variantId) ?? 0) - (before.get(variantId) ?? 0);
        const stockLine = { variantId, locationId: order.locationId, quantity: Math.abs(change) };
        if (change > 0) commit.push(stockLine);
        else if (change < 0) release.push(stockLine);
      }
      const rewrite: Rewrite = {
        current,
        edited,
        discount: order.discount,
        transferDiscount: order.transferDiscount,
        shipping: order.shipping,
        stock: { commit, release },
        field: ['input'],
        shortField: (variantId) => {
          const line =
            edited.find((each) => each.variantId === variantId && each.field) ??
            edited.find((each) => each.variantId === variantId)!;
          return [...(line.field ?? ['input']), 'quantity'];
        },
        also: {},
        kind: 'edited',
        message: (totals) => changeWords('Changed the items', current, edited, totals),
        changed: ['lineItems'],
      };
      const amounts = await this.#prepare(tx, tenant, order, rewrite);
      if (!amounts.ok) return amounts;
      await this.#write(tx, tenant, order, rewrite, amounts.value);
      return { ok: true, value: (await loadOrder(tx, shopId, order.id))! };
    });
  }

  /**
   * Changes what an order charges for delivery and takes off its items while it waits to be
   * packed (ORD-04, ADR-134), as an agent waives the one or gives the other on the call: its
   * totals, tax, cash at the door and risk follow, as an edit's do. What was taken off for paying
   * by transfer stays part of the discount. One that changes nothing leaves the order as it is.
   */
  async editCharges(
    tenant: TenantContext,
    id: string,
    edit: OrderChargesEdit,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const shipping = check.price(['input', 'shippingPrice'], edit.shippingPrice, tenant.currency);
    const discount = check.price(['input', 'discount'], edit.discount, tenant.currency);
    if (shipping === null && discount === null && check.ok) {
      check.addMessage(['input'], 'BLANK', 'Give a delivery charge or a discount');
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const { shopId } = tenant;

    return this.db.tenant(shopId, async (tx): Promise<MutationResult<OrderRecord>> => {
      const order = await lockOrder(tx, shopId, id);
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      const refusal = editRefusal(order, 'charges');
      if (refusal) return failOne(['id'], 'INVALID', refusal);
      const newShipping = shipping ?? order.shipping;
      const newDiscount = discount ?? order.discount;
      if (newShipping === order.shipping && newDiscount === order.discount) {
        return { ok: true, value: (await loadOrder(tx, shopId, order.id))! };
      }
      const currency = order.currency as CurrencyCode;
      const format = (value: bigint) => formatMoney(money(value, currency));
      if (newDiscount < order.transferDiscount) {
        return failOne(
          ['input', 'discount'],
          'INVALID',
          `${format(order.transferDiscount)} of the discount was taken off for paying by ` +
            "transfer: it can't be less",
        );
      }
      const current = await linesOf(tx, shopId, order.id);
      const snapshots = await this.variants.snapshotsOf(
        tx,
        shopId,
        current.map((line) => line.variantId),
      );
      const edited: EditedLine[] = current.map((line) => ({
        ...line,
        taxCode: snapshots.get(line.variantId)?.taxCode ?? null,
        field: null,
      }));
      const parts: string[] = [];
      const changed: string[] = [];
      if (newShipping !== order.shipping) {
        parts.push(`the delivery charge to ${format(newShipping)} from ${format(order.shipping)}`);
        changed.push('shipping');
      }
      if (newDiscount !== order.discount) {
        parts.push(`the discount to ${format(newDiscount)} from ${format(order.discount)}`);
        changed.push('discount');
      }
      const rewrite: Rewrite = {
        current,
        edited,
        discount: newDiscount,
        transferDiscount: order.transferDiscount,
        shipping: newShipping,
        stock: { commit: [], release: [] },
        field: ['input'],
        shortField: () => ['input'],
        also: {},
        kind: 'edited',
        message: (totals) =>
          `Changed ${parts.join(', and ')}` +
          (totals ? `; ${totals[0]} instead of ${totals[1]}` : ''),
        changed,
      };
      const amounts = await this.#prepare(tx, tenant, order, rewrite);
      if (!amounts.ok) {
        // Its items cost what they did: an error about its amounts is about the discount.
        return {
          ok: false,
          errors: amounts.errors.map((error) =>
            error.code === 'INVALID' && newDiscount !== order.discount
              ? { ...error, field: ['input', 'discount'] }
              : error,
          ),
        };
      }
      await this.#write(tx, tenant, order, rewrite, amounts.value);
      return { ok: true, value: (await loadOrder(tx, shopId, order.id))! };
    });
  }

  /**
   * Merges order `id` into order `intoId` (ORD-04, ADR-132), as when a customer placed one order
   * twice, or a second for something to go with the first: the order merged into takes its items,
   * at the prices they were sold at, its discount and its discount codes, its note and tags where
   * they fit, and keeps its own address, delivery charge and fee, as one parcel. Its amounts,
   * stock and risk follow, as an edit's do. The order merged is cancelled as `merged`, naming the
   * other; its stock becomes the other's, moved if they ship from different locations. Both must
   * wait to be packed and be the same customer's, paid the same way, and the order merged have
   * nothing paid or asked for in advance: what was paid stays with the order it was paid for.
   */
  async merge(
    tenant: TenantContext,
    id: string,
    intoId: string,
  ): Promise<MutationResult<{ order: OrderRecord; merged: OrderRecord }>> {
    if (id === intoId) {
      return failOne(['intoId'], 'INVALID', "An order can't be merged into itself");
    }
    const { shopId } = tenant;
    return this.db.tenant(
      shopId,
      async (tx): Promise<MutationResult<{ order: OrderRecord; merged: OrderRecord }>> => {
        // Both locked, the lower ID first, as any merge of the two locks them.
        const locked = new Map<string, OrderRow>();
        for (const orderId of [id, intoId].sort()) {
          const row = await lockOrder(tx, shopId, orderId);
          if (row) locked.set(orderId, row);
        }
        const merged = locked.get(id);
        const into = locked.get(intoId);
        if (!merged) return failOne(['id'], 'NOT_FOUND', 'Order not found');
        if (!into) return failOne(['intoId'], 'NOT_FOUND', 'Order not found');
        const refusal = mergeRefusal(merged);
        if (refusal) return failOne(['id'], 'INVALID', refusal);
        const intoRefusal = mergeRefusal(into);
        if (intoRefusal) return failOne(['intoId'], 'INVALID', intoRefusal);
        if (merged.customerId !== into.customerId) {
          return failOne(
            ['intoId'],
            'INVALID',
            "Only one customer's orders merge, into one parcel for them",
          );
        }
        if (merged.paymentMethod !== into.paymentMethod) {
          return failOne(['intoId'], 'INVALID', 'Only orders paid the same way merge');
        }
        if (merged.amountPaid > 0n || merged.advanceDue > 0n) {
          return failOne(
            ['id'],
            'INVALID',
            `${orderName(merged.number)} has money paid or asked for in advance: merge the ` +
              'other order into it instead',
          );
        }

        const current = await linesOf(tx, shopId, into.id);
        const taken = await linesOf(tx, shopId, merged.id);
        const snapshots = await this.variants.snapshotsOf(
          tx,
          shopId,
          [...current, ...taken].map((line) => line.variantId),
        );
        const taxCode = (variantId: string) => snapshots.get(variantId)?.taxCode ?? null;
        const edited: EditedLine[] = current.map((line) => ({
          ...line,
          taxCode: taxCode(line.variantId),
          field: null,
        }));
        // A line of the same variant at the same price and cost takes its units; any other is
        // added.
        for (const line of taken) {
          const same = edited.find(
            (each) =>
              each.variantId === line.variantId &&
              each.unitPrice === line.unitPrice &&
              each.unitCost === line.unitCost &&
              each.taxable === line.taxable,
          );
          if (same) same.quantity += line.quantity;
          else {
            edited.push({
              ...line,
              id: newId(),
              createdAt: null,
              taxCode: taxCode(line.variantId),
              field: null,
            });
          }
        }
        if (edited.length > LIMITS.lines) {
          return failOne(
            ['id'],
            'TOO_MANY',
            `Together they would have more than the ${LIMITS.lines} items an order has at most`,
          );
        }
        // Its units are committed already; shipped from another location, they move there.
        const commit: StockLine[] = [];
        const release: StockLine[] = [];
        if (merged.locationId !== into.locationId) {
          for (const [variantId, quantity] of unitsByVariant(taken)) {
            commit.push({ variantId, locationId: into.locationId, quantity });
            release.push({ variantId, locationId: merged.locationId, quantity });
          }
        }
        const also: Partial<OrderRow> = {};
        const changed = ['lineItems'];
        const note = joinedNote(into.note, merged.note);
        if (note !== into.note) {
          also.note = note;
          changed.push('note');
        }
        const tags = [...new Set([...into.tags, ...merged.tags])];
        if (tags.length > into.tags.length && tags.length <= INPUT_LIMITS.tags) {
          also.tags = tags;
          changed.push('tags');
        }
        const codes = [...new Set([...into.discountCodes, ...merged.discountCodes])];
        if (codes.length > into.discountCodes.length) also.discountCodes = codes;

        const name = orderName(merged.number);
        const rewrite: Rewrite = {
          current,
          edited,
          discount: into.discount + merged.discount,
          transferDiscount: into.transferDiscount + merged.transferDiscount,
          shipping: into.shipping,
          stock: { commit, release },
          field: ['intoId'],
          shortField: () => ['id'],
          also,
          kind: 'merged',
          message: (totals) =>
            changeWords(`Merged ${name} into this order`, current, edited, totals),
          changed,
        };
        const amounts = await this.#prepare(tx, tenant, into, rewrite);
        if (!amounts.ok) return amounts;
        // The order merged goes first, so that the other's risk no longer counts it.
        const cancelled = await updateOrder(
          tx,
          shopId,
          merged,
          { status: 'cancelled', cancelReason: 'merged', mergedIntoId: into.id },
          ['cancelledAt'],
        );
        await addTimelineEntry(
          tx,
          shopId,
          merged.id,
          tenant.actor,
          'merged',
          `Merged into ${orderName(into.number)}, which took its items`,
        );
        await appendEvent<OrderCancelledPayload>(tx, shopId, {
          type: OrderEvents.OrderCancelled,
          aggregateType: 'order',
          aggregateId: merged.id,
          payload: { reason: 'merged', stage: cancelled.stage, version: cancelled.version },
        });
        await this.#write(tx, tenant, into, rewrite, amounts.value);
        return {
          ok: true,
          value: {
            order: (await loadOrder(tx, shopId, into.id))!,
            merged: (await loadOrder(tx, shopId, merged.id))!,
          },
        };
      },
    );
  }

  /**
   * Splits lines of order `id` off as an order of their own (ORD-04, ADR-135), as when part of it
   * waits for stock, or its customer wants part sooner: cash on delivery is collected by order, so
   * a part sent apart is one. The part takes the units given, at the prices they were sold at, and
   * its share of the discount by what they cost; its delivery charge is `shippingPrice`, nothing
   * if left out, and the order keeps its own, and its fee. Both orders' totals, tax and cash at
   * the door are worked out again, and both are scored as the one order their customer placed.
   * The part takes the rest of the order as it is, its customer, address, confirmation, calls,
   * assignee and when it was placed among it, and names it; its stock stays committed where it
   * was. Only an order paid on delivery that waits to be packed, with nothing paid or asked for
   * in advance, is split.
   */
  async split(
    tenant: TenantContext,
    id: string,
    input: OrderSplitInput,
  ): Promise<MutationResult<{ order: OrderRecord; split: OrderRecord }>> {
    const check = new InputChecker();
    const entries = input.lineItems ?? [];
    if (entries.length === 0) {
      check.addMessage(['input', 'lineItems'], 'BLANK', 'Name the items to send apart');
    } else if (entries.length > LIMITS.lines) {
      check.add(['input', 'lineItems'], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
    const named = new Set<string>();
    const asked = entries.map((entry, index) => {
      const field = ['input', 'lineItems', String(index)];
      if (named.has(entry.lineItemId)) {
        check.addMessage([...field, 'lineItemId'], 'INVALID', 'The line item is given twice');
      }
      named.add(entry.lineItemId);
      const quantity = check.integer([...field, 'quantity'], entry.quantity, {
        min: 1,
        max: LIMITS.quantity,
      });
      return { lineItemId: entry.lineItemId, quantity: quantity ?? 0, field };
    });
    const shipping =
      check.price(['input', 'shippingPrice'], input.shippingPrice, tenant.currency) ?? 0n;
    if (!check.ok) return { ok: false, errors: check.errors };
    const { shopId } = tenant;

    return this.db.tenant(
      shopId,
      async (tx): Promise<MutationResult<{ order: OrderRecord; split: OrderRecord }>> => {
        const order = await lockOrder(tx, shopId, id);
        if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
        const refusal = splitRefusal(order);
        if (refusal) return failOne(['id'], 'INVALID', refusal);
        const current = await linesOf(tx, shopId, order.id);
        const byId = new Map(current.map((line) => [line.id, line]));
        const errors: FieldError[] = [];
        for (const entry of asked) {
          const line = byId.get(entry.lineItemId);
          if (!line) {
            errors.push({
              field: [...entry.field, 'lineItemId'],
              code: 'NOT_FOUND',
              message: 'Line item not found on this order',
            });
          } else if (entry.quantity > line.quantity) {
            errors.push({
              field: [...entry.field, 'quantity'],
              code: 'INVALID',
              message: `The order has ${line.quantity} of "${itemName(line)}"`,
            });
          }
        }
        if (errors.length > 0) return { ok: false, errors };

        const snapshots = await this.variants.snapshotsOf(
          tx,
          shopId,
          current.map((line) => line.variantId),
        );
        const taxCode = (variantId: string) => snapshots.get(variantId)?.taxCode ?? null;
        const sent = new Map(asked.map((entry) => [entry.lineItemId, entry.quantity]));
        const kept: EditedLine[] = [];
        const apart: EditedLine[] = [];
        for (const line of current) {
          const moving = sent.get(line.id) ?? 0;
          const fields = { taxCode: taxCode(line.variantId), field: null };
          if (line.quantity > moving) {
            kept.push({ ...line, ...fields, quantity: line.quantity - moving });
          }
          if (moving > 0) {
            apart.push({ ...line, ...fields, id: newId(), quantity: moving, createdAt: null });
          }
        }
        if (kept.length === 0) {
          return failOne(
            ['input', 'lineItems'],
            'INVALID',
            'An order keeps at least one item: send apart less than all of it',
          );
        }

        // The discount is shared by what the items cost. An order paid on delivery has nothing
        // taken off for paying by transfer.
        const currency = order.currency as CurrencyCode;
        const cost = (items: readonly EditedLine[]) =>
          items.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n);
        const [keptDiscount, apartDiscount] = discountShares(
          order.discount,
          [cost(kept), cost(apart)],
          currency,
        );
        let apartName = '';
        const rewrite: Rewrite = {
          current,
          edited: kept,
          discount: keptDiscount,
          transferDiscount: order.transferDiscount,
          shipping: order.shipping,
          stock: { commit: [], release: [] },
          field: ['input'],
          shortField: () => ['input'],
          also: {},
          kind: 'split',
          message: (totals) =>
            itemsWords(
              'Split off ',
              apart,
              ` as ${apartName}` + (totals ? `; ${totals[0]} instead of ${totals[1]}` : ''),
            ),
          changed: keptDiscount === order.discount ? ['lineItems'] : ['lineItems', 'discount'],
        };
        const amounts = await this.#prepare(tx, tenant, order, rewrite);
        if (!amounts.ok) return amounts;
        // The part's amounts, as an order's with nothing on it yet; its stock is committed.
        const partId = newId();
        const nothing = { subtotal: 0n, total: 0n, codFee: 0n, codAmount: 0n, amountPaid: 0n };
        const part = await this.#prepare(
          tx,
          tenant,
          { ...order, ...nothing, id: partId },
          {
            ...rewrite,
            current: [],
            edited: apart,
            discount: apartDiscount,
            transferDiscount: 0n,
            shipping,
            field: ['input', 'shippingPrice'],
          },
        );
        if (!part.ok) return part;

        const number = await nextOrderNumber(tx, shopId);
        apartName = orderName(number);
        const { subtotal, total, codAmount, tax } = part.value;
        // Scored as the one order its customer placed, as the order is again.
        let risk: RiskAssessment | null = null;
        let held = false;
        if (order.riskScore !== null && !order.customerErasedAt) {
          const { assessment, settings } = await assessOrderRisk(tx, shopId, {
            orderId: partId,
            splitFromId: order.splitFromId ?? order.id,
            customerId: order.customerId,
            total,
            currency,
            units: apart.reduce((sum, line) => sum + line.quantity, 0),
            address: order.shippingAddress as AddressValue,
            placedAt: order.createdAt,
          });
          risk = assessment;
          held =
            order.confirmationStatus !== 'needs_review' &&
            !holdsForRisk(settings, order.riskScore) &&
            holdsForRisk(settings, assessment.score);
        }
        const statuses = {
          status: 'open' as const,
          confirmationStatus: held ? ('needs_review' as const) : order.confirmationStatus,
          financialStatus: 'pending' as const,
          fulfillmentStatus: 'unfulfilled' as const,
          packedAt: null,
        };
        // The rest of the order as it is: its customer, address, note and tags, confirmation and
        // calls, assignee, agreement, the visits that brought its customer (ADR-139) and when it
        // was placed. Its link is its own, made when sent.
        const [row] = await tx
          .insert(orders)
          .values({
            ...order,
            ...statuses,
            id: partId,
            number,
            stage: stageOf({
              ...statuses,
              paymentMethod: order.paymentMethod,
              amountPaid: 0n,
              total,
              advanceDue: 0n,
            }),
            subtotal,
            discount: apartDiscount,
            shipping,
            codFee: 0n,
            taxRate: tax.rate,
            totalTax: tax.total,
            shippingTax: tax.charges,
            transferDiscount: 0n,
            total,
            amountPaid: 0n,
            amountRefunded: 0n,
            codAmount,
            advanceDue: 0n,
            ...(risk && riskColumns(risk)),
            splitFromId: order.splitFromId ?? order.id,
            linkTokenHash: null,
            linkExpiresAt: null,
            paidAt: null,
            version: 1,
            updatedAt: new Date(),
          })
          .returning();
        await tx.insert(lines).values(lineValues(shopId, partId, apart, tax));
        await addTimelineEntry(
          tx,
          shopId,
          partId,
          tenant.actor,
          'split',
          itemsWords(
            `Split from ${orderName(order.number)}: `,
            apart,
            `; ${formatMoney(money(total, currency))}`,
          ),
        );
        if (held) {
          await addTimelineEntry(tx, shopId, partId, 'system', 'held', heldForRiskMessage(risk!));
        }
        await appendEvent<OrderCreatedPayload>(tx, shopId, {
          type: OrderEvents.OrderCreated,
          aggregateType: 'order',
          aggregateId: partId,
          payload: {
            number,
            customerId: order.customerId,
            source: order.source,
            paymentMethod: order.paymentMethod,
            total: total.toString(),
            currency,
            riskLevel: row!.riskLevel,
            stage: row!.stage,
            version: row!.version,
          },
        });
        await this.#write(tx, tenant, order, rewrite, amounts.value);
        return {
          ok: true,
          value: {
            order: (await loadOrder(tx, shopId, order.id))!,
            split: (await loadOrder(tx, shopId, partId))!,
          },
        };
      },
    );
  }

  /**
   * Works out what `order` comes to as `rewrite` leaves it, at the prices its lines keep: its
   * delivery charge as the rewrite has it, its fee as it was, and the sales tax again at the
   * shop's rates now (ADR-096, ADR-097). Then moves its stock, which is the last of it and writes nothing when it
   * falls short, so that nothing is written when this returns errors.
   */
  async #prepare(
    tx: Tx,
    tenant: TenantContext,
    order: OrderRow,
    rewrite: Rewrite,
  ): Promise<MutationResult<Amounts>> {
    const { shopId } = tenant;
    const { edited, discount, field } = rewrite;
    const currency = order.currency as CurrencyCode;
    const format = (value: bigint) => formatMoney(money(value, currency));
    const subtotal = edited.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n);
    if (discount > subtotal) {
      return failOne(
        field,
        'INVALID',
        `Its discount of ${format(discount)} would be more than its items cost, ` +
          format(subtotal),
      );
    }
    const total = subtotal - discount + rewrite.shipping + order.codFee;
    if (order.amountPaid > total) {
      return failOne(
        field,
        'INVALID',
        `${format(order.amountPaid)} is paid on it already, more than its new total of ` +
          format(total),
      );
    }
    // Cash at the door takes the difference: what was paid or asked for in advance stays.
    const cod = order.paymentMethod === 'cash_on_delivery';
    const codAmount = cod ? order.codAmount + total - order.total : 0n;
    if (codAmount < 0n) {
      return failOne(
        field,
        'INVALID',
        `Its new total of ${format(total)} would be less than its advance, paid or asked for`,
      );
    }
    if (
      codLimitError(field, {
        paymentMethod: order.paymentMethod,
        currency,
        total,
        advance: total - codAmount,
      })
    ) {
      return failOne(
        field,
        'COD_LIMIT',
        `Cash on delivery can't collect more than ${format(COD_CASH_LIMIT)} an order, and ` +
          `these items would collect ${format(codAmount)}`,
      );
    }
    const tax = orderTaxOf(await taxSettingsIn(tx, shopId), {
      lines: edited.map((line) => ({
        total: line.unitPrice * BigInt(line.quantity),
        taxable: line.taxable,
        taxCode: line.taxCode,
      })),
      discount,
      charges: rewrite.shipping + order.codFee,
    });

    const moved = await this.stock.recommit(tx, { shopId, actor: tenant.actor }, rewrite.stock, {
      referenceDocumentUri: orderReference(order.id),
    });
    if (!moved.ok) {
      const location = (await this.locations.locationsOf(tx, shopId, [order.locationId])).get(
        order.locationId,
      );
      const where = location ? ` at ${location.name}` : '';
      const before = new Set(rewrite.current.map((line) => line.variantId));
      return {
        ok: false,
        errors: moved.shortages.map((shortage) => {
          const title = edited.find((each) => each.variantId === shortage.variantId)!.title;
          const left = Math.max(shortage.available, 0);
          const more = before.has(shortage.variantId) ? ' more' : '';
          return {
            field: rewrite.shortField(shortage.variantId),
            code: 'OUT_OF_STOCK',
            message:
              left === 0
                ? `"${title}" is out of stock${where}`
                : `Only ${left}${more} of "${title}" left${where}`,
          };
        }),
      };
    }
    return { ok: true, value: { subtotal, total, codAmount, tax } };
  }

  /**
   * Writes the order's lines and amounts as {@link #prepare} worked them out, scores it again,
   * and says what changed on its timeline and in `order.updated`.
   */
  async #write(
    tx: Tx,
    tenant: TenantContext,
    order: OrderRow,
    rewrite: Rewrite,
    amounts: Amounts,
  ): Promise<void> {
    const { shopId } = tenant;
    const { edited } = rewrite;
    const { subtotal, total, codAmount, tax } = amounts;
    const currency = order.currency as CurrencyCode;
    const format = (value: bigint) => formatMoney(money(value, currency));

    // Its lines, in their order, those added after them.
    await tx.delete(lines).where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
    await tx.insert(lines).values(lineValues(shopId, order.id, edited, tax));

    const financialStatus =
      order.amountPaid === total
        ? ('paid' as const)
        : order.amountPaid > 0n
          ? ('partially_paid' as const)
          : ('pending' as const);
    const changes: Partial<OrderRow> = {
      subtotal,
      discount: rewrite.discount,
      transferDiscount: rewrite.transferDiscount,
      shipping: rewrite.shipping,
      total,
      taxRate: tax.rate,
      totalTax: tax.total,
      shippingTax: tax.charges,
      codAmount,
      financialStatus,
      ...(financialStatus !== 'paid' && { paidAt: null }),
      ...rewrite.also,
    };
    const stamps: OrderStamp[] = financialStatus === 'paid' && !order.paidAt ? ['paidAt'] : [];
    // A cash-on-delivery order scored when it was placed is scored again for what it holds now,
    // and waits for review if that is what makes it risky, as a new address does.
    let held: RiskAssessment | null = null;
    if (order.riskScore !== null && !order.customerErasedAt) {
      const { assessment, settings } = await assessOrderRisk(tx, shopId, {
        orderId: order.id,
        splitFromId: order.splitFromId,
        customerId: order.customerId,
        total,
        currency,
        units: edited.reduce((sum, line) => sum + line.quantity, 0),
        address: order.shippingAddress as AddressValue,
        placedAt: order.createdAt,
      });
      Object.assign(changes, riskColumns(assessment));
      if (
        order.advanceDue === 0n &&
        order.confirmationStatus !== 'needs_review' &&
        !holdsForRisk(settings, order.riskScore) &&
        holdsForRisk(settings, assessment.score)
      ) {
        changes.confirmationStatus = 'needs_review';
        held = assessment;
      }
    }
    const updated = await updateOrder(tx, shopId, order, changes, stamps);
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      tenant.actor,
      rewrite.kind,
      rewrite.message(order.total === total ? null : [format(total), format(order.total)]),
    );
    if (held) {
      await addTimelineEntry(tx, shopId, order.id, 'system', 'held', heldForRiskMessage(held));
    }
    await appendEvent<OrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.OrderUpdated,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { changed: rewrite.changed, stage: updated.stage, version: updated.version },
    });
  }
}

/** The edit's lists, checked, each entry with where it is in the input. */
function checkEdit(
  tenant: TenantContext,
  edit: OrderLineItemsEdit,
): MutationResult<{
  quantities: { lineItemId: string; quantity: number; field: string[] }[];
  additions: { variantId: string; quantity: number; price: bigint | null; field: string[] }[];
}> {
  const check = new InputChecker();
  const setQuantities = edit.setQuantities ?? [];
  const addVariants = edit.addVariants ?? [];
  if (setQuantities.length === 0 && addVariants.length === 0) {
    check.addMessage(['input'], 'BLANK', 'Change the quantity of an item, or add one');
  }
  for (const [name, list] of [
    ['setQuantities', setQuantities],
    ['addVariants', addVariants],
  ] as const) {
    if (list.length > LIMITS.lines) {
      check.add(['input', name], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
  }
  const lineIds = new Set<string>();
  const quantities = setQuantities.map((entry, index) => {
    const field = ['input', 'setQuantities', String(index)];
    if (lineIds.has(entry.lineItemId)) {
      check.addMessage([...field, 'lineItemId'], 'INVALID', 'The line item is given twice');
    }
    lineIds.add(entry.lineItemId);
    const quantity = check.integer([...field, 'quantity'], entry.quantity, {
      min: 0,
      max: LIMITS.quantity,
    });
    return { lineItemId: entry.lineItemId, quantity: quantity ?? 0, field };
  });
  const variantIds = new Set<string>();
  const additions = addVariants.map((line, index) => {
    const field = ['input', 'addVariants', String(index)];
    if (variantIds.has(line.variantId)) {
      check.addMessage(
        [...field, 'variantId'],
        'INVALID',
        'The variant is added twice: add it once, with all its units',
      );
    }
    variantIds.add(line.variantId);
    const quantity = check.integer([...field, 'quantity'], line.quantity, {
      min: 1,
      max: LIMITS.quantity,
    });
    const price = check.price([...field, 'price'], line.price, tenant.currency);
    return { variantId: line.variantId, quantity: quantity ?? 0, price, field };
  });
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, value: { quantities, additions } };
}

/** Why an order's items, or its charges, can't change now; null if they can. */
function editRefusal(order: OrderRow, what: 'items' | 'charges' = 'items'): string | null {
  if (order.status === 'cancelled') return `A cancelled order's ${what} can't change`;
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return `Its ${what} can't change once it has shipped`;
  }
  if (order.packedAt) return `It is packed: mark it unpacked first, then change its ${what}`;
  // Refunds were worked out from its items and tax as they are.
  if (order.amountRefunded > 0n) return `It has refunds, so its ${what} can't change`;
  return null;
}

/**
 * `discount` shared between items costing `costs`, by the largest remainder: in whole rupees when
 * it is whole, so that the cash each order collects stays whole too.
 */
function discountShares(
  discount: bigint,
  costs: [kept: bigint, apart: bigint],
  currency: CurrencyCode,
): [kept: bigint, apart: bigint] {
  if (discount === 0n) return [0n, 0n];
  const unit = 10n ** BigInt(exponentOf(currency));
  const step = discount % unit === 0n ? unit : 1n;
  const [kept, apart] = allocate(money(discount / step, currency), costs);
  return [kept!.amount * step, apart!.amount * step];
}

/** Why an order can't be split now; null if it can. */
function splitRefusal(order: OrderRow): string | null {
  if (order.status === 'cancelled') return "A cancelled order can't be split";
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return "It can't be split once it has shipped";
  }
  if (order.packedAt) return 'It is packed: mark it unpacked first, then split it';
  if (order.amountRefunded > 0n) return "It has refunds, so it can't be split";
  if (order.paymentMethod !== 'cash_on_delivery') {
    return 'Only an order paid on delivery is split, its cash collected by parcel: ship this one in parts instead';
  }
  if (order.amountPaid > 0n || order.advanceDue > 0n) {
    return "It has money paid or asked for in advance, which is for all of it: it can't be split";
  }
  return null;
}

/** Why an order can't be merged, or merged into, now; null if it can. */
function mergeRefusal(order: OrderRow): string | null {
  const name = orderName(order.number);
  if (order.cancelReason === 'merged') return `${name} was merged into another order already`;
  if (order.status === 'cancelled') return `${name} is cancelled`;
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return `${name} has shipped`;
  }
  if (order.packedAt) return `${name} is packed: mark it unpacked first`;
  if (order.amountRefunded > 0n) return `${name} has refunds`;
  return null;
}

/** Rows for an order's lines as `edited` has them, in their order, with their tax. */
function lineValues(
  shopId: string,
  orderId: string,
  edited: readonly EditedLine[],
  tax: Amounts['tax'],
): (typeof lines.$inferInsert)[] {
  return edited.map((line, index) => ({
    shopId,
    id: line.id,
    orderId,
    position: index + 1,
    variantId: line.variantId,
    productId: line.productId,
    title: line.title,
    variantTitle: line.variantTitle,
    sku: line.sku,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    total: line.unitPrice * BigInt(line.quantity),
    unitCost: line.unitCost,
    weightGrams: line.weightGrams,
    taxable: line.taxable,
    taxRate: tax.lines[index]!.rate,
    tax: tax.lines[index]!.tax,
    ...(line.createdAt && { createdAt: line.createdAt }),
  }));
}

/** The order's lines, in their order. */
function linesOf(tx: Tx, shopId: string, orderId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(lines)
    .where(and(eq(lines.shopId, shopId), eq(lines.orderId, orderId)))
    .orderBy(asc(lines.position));
}

/** Two orders' notes as one, the second after the first, if they fit; else the first. */
function joinedNote(first: string, second: string): string {
  if (!second || first.includes(second)) return first;
  if (!first) return second;
  const joined = `${first}\n\n${second}`;
  return joined.length <= LIMITS.note ? joined : first;
}

function notForSale(snapshot: VariantSnapshot | undefined): boolean {
  return !snapshot || snapshot.productStatus === 'archived';
}

/** Units of each variant, over its lines. */
function unitsByVariant(
  orderLines: readonly { variantId: string; quantity: number }[],
): Map<string, number> {
  const units = new Map<string, number>();
  for (const line of orderLines) {
    units.set(line.variantId, (units.get(line.variantId) ?? 0) + line.quantity);
  }
  return units;
}

/**
 * The timeline's words for a change of items, after `what`: "Changed the items: 2 × Lawn Suit (M)
 * instead of 1, added 1 × Peshawari Chappal (8), removed Dupatta; Rs 7,400 instead of Rs 5,200".
 * As many changes as an entry holds are named, the rest counted.
 */
function changeWords(
  what: string,
  current: readonly LineRow[],
  edited: readonly EditedLine[],
  totals: [now: string, was: string] | null,
): string {
  const kept = new Map(edited.map((line) => [line.id, line]));
  const was = new Set(current.map((line) => line.id));
  const parts: string[] = [];
  for (const line of current) {
    const now = kept.get(line.id);
    if (!now) parts.push(`removed ${itemName(line)}`);
    else if (now.quantity !== line.quantity) {
      parts.push(`${now.quantity} × ${itemName(line)} instead of ${line.quantity}`);
    }
  }
  for (const line of edited) {
    if (!was.has(line.id)) parts.push(`added ${line.quantity} × ${itemName(line)}`);
  }
  const ending = totals ? `; ${totals[0]} instead of ${totals[1]}` : '';
  const words = (shown: number) =>
    `${what}: ${parts.slice(0, shown).join(', ')}` +
    (shown < parts.length ? `, and ${parts.length - shown} more` : '') +
    ending;
  let shown = parts.length;
  while (shown > 1 && words(shown).length > LIMITS.comment) shown -= 1;
  return words(shown);
}

/**
 * The timeline's words for items sent apart, between `what` and `ending`: "Split off 2 × Kurta,
 * 1 × Dupatta as #1033". As many as an entry holds are named, the rest counted.
 */
function itemsWords(what: string, items: readonly EditedLine[], ending: string): string {
  const parts = items.map((line) => `${line.quantity} × ${itemName(line)}`);
  const words = (shown: number) =>
    what +
    parts.slice(0, shown).join(', ') +
    (shown < parts.length ? `, and ${parts.length - shown} more` : '') +
    ending;
  let shown = parts.length;
  while (shown > 1 && words(shown).length > LIMITS.comment) shown -= 1;
  return words(shown);
}

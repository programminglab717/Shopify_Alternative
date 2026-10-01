import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { VariantService, type VariantSnapshot } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { LocationService, StockService, type StockLine } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { orderTaxOf, taxSettingsIn } from '@hatti/tax/public';
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import type { OrderLineInput } from './order.service.js';
import { assessOrderRisk, riskColumns } from './order-risk.js';
import {
  addTimelineEntry,
  loadOrder,
  lockOrder,
  orderReference,
  updateOrder,
  type OrderStamp,
} from './order-store.js';
import type { OrderRecord } from './records.js';
import { heldForRiskMessage, holdsForRisk, type RiskAssessment } from './risk.js';
import { COD_CASH_LIMIT, LIMITS, codLimitError, itemName } from './rules.js';
import { lines, type AddressValue, type LineRow, type OrderRow } from './schema.js';

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
  weightGrams: number | null;
  taxable: boolean;
  /** Its variant's tax code now, for its rate; null when the variant is gone. */
  taxCode: string | null;
  /** A kept line's; null for a line added, which is new. */
  createdAt: Date | null;
  /** Where the edit names it, for errors; null for a kept line the edit leaves as it is. */
  field: string[] | null;
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
      const current = await tx
        .select()
        .from(lines)
        .where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)))
        .orderBy(asc(lines.position));
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

      // Its totals, at the prices its lines keep: its discount, delivery charge and fee as they
      // were, and the sales tax worked out again at the shop's rates now (ADR-096, ADR-097).
      const currency = order.currency as CurrencyCode;
      const format = (value: bigint) => formatMoney(money(value, currency));
      const subtotal = edited.reduce(
        (sum, line) => sum + line.unitPrice * BigInt(line.quantity),
        0n,
      );
      if (order.discount > subtotal) {
        return failOne(
          ['input'],
          'INVALID',
          `Its discount of ${format(order.discount)} would be more than its items cost, ` +
            format(subtotal),
        );
      }
      const total = subtotal - order.discount + order.shipping + order.codFee;
      if (order.amountPaid > total) {
        return failOne(
          ['input'],
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
          ['input'],
          'INVALID',
          `Its new total of ${format(total)} would be less than its advance, paid or asked for`,
        );
      }
      if (
        codLimitError(['input'], {
          paymentMethod: order.paymentMethod,
          currency,
          total,
          advance: total - codAmount,
        })
      ) {
        return failOne(
          ['input'],
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
        discount: order.discount,
        charges: order.shipping + order.codFee,
      });

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
      const moved = await this.stock.recommit(
        tx,
        { shopId, actor: tenant.actor },
        { commit, release },
        { referenceDocumentUri: orderReference(order.id) },
      );
      if (!moved.ok) {
        const location = (await this.locations.locationsOf(tx, shopId, [order.locationId])).get(
          order.locationId,
        );
        const where = location ? ` at ${location.name}` : '';
        return {
          ok: false,
          errors: moved.shortages.map((shortage) => {
            const line =
              edited.find((each) => each.variantId === shortage.variantId && each.field) ??
              edited.find((each) => each.variantId === shortage.variantId)!;
            const left = Math.max(shortage.available, 0);
            const more = before.has(shortage.variantId) ? ' more' : '';
            return {
              field: [...(line.field ?? ['input']), 'quantity'],
              code: 'OUT_OF_STOCK',
              message:
                left === 0
                  ? `"${line.title}" is out of stock${where}`
                  : `Only ${left}${more} of "${line.title}" left${where}`,
            };
          }),
        };
      }

      // Its lines, in their order, the variants added after them.
      await tx.delete(lines).where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
      await tx.insert(lines).values(
        edited.map((line, index) => ({
          shopId,
          id: line.id,
          orderId: order.id,
          position: index + 1,
          variantId: line.variantId,
          productId: line.productId,
          title: line.title,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.unitPrice * BigInt(line.quantity),
          weightGrams: line.weightGrams,
          taxable: line.taxable,
          taxRate: tax.lines[index]!.rate,
          tax: tax.lines[index]!.tax,
          ...(line.createdAt && { createdAt: line.createdAt }),
        })),
      );

      const financialStatus =
        order.amountPaid === total
          ? ('paid' as const)
          : order.amountPaid > 0n
            ? ('partially_paid' as const)
            : ('pending' as const);
      const changes: Partial<OrderRow> = {
        subtotal,
        total,
        taxRate: tax.rate,
        totalTax: tax.total,
        shippingTax: tax.charges,
        codAmount,
        financialStatus,
        ...(financialStatus !== 'paid' && { paidAt: null }),
      };
      const stamps: OrderStamp[] = financialStatus === 'paid' && !order.paidAt ? ['paidAt'] : [];
      // A cash-on-delivery order scored when it was placed is scored again for what it holds now,
      // and waits for review if that is what makes it risky, as a new address does.
      let held: RiskAssessment | null = null;
      if (order.riskScore !== null && !order.customerErasedAt) {
        const { assessment, settings } = await assessOrderRisk(tx, shopId, {
          orderId: order.id,
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
        'edited',
        editMessage(
          current,
          edited,
          order.total === total ? null : [format(total), format(order.total)],
        ),
      );
      if (held) {
        await addTimelineEntry(tx, shopId, order.id, 'system', 'held', heldForRiskMessage(held));
      }
      await appendEvent<OrderUpdatedPayload>(tx, shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['lineItems'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: (await loadOrder(tx, shopId, order.id))! };
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

/** Why an order's items can't change now, or null if they can. */
function editRefusal(order: OrderRow): string | null {
  if (order.status === 'cancelled') return "A cancelled order's items can't change";
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return "Its items can't change once it has shipped";
  }
  if (order.packedAt) return 'It is packed: mark it unpacked first, then change its items';
  // Refunds were worked out from its items and tax as they are.
  if (order.amountRefunded > 0n) return "It has refunds, so its items can't change";
  return null;
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
 * The timeline's words for an edit: "Changed the items: 2 × Lawn Suit (M) instead of 1, added
 * 1 × Peshawari Chappal (8), removed Dupatta; Rs 7,400 instead of Rs 5,200". As many changes as
 * an entry holds are named, the rest counted.
 */
function editMessage(
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
    `Changed the items: ${parts.slice(0, shown).join(', ')}` +
    (shown < parts.length ? `, and ${parts.length - shown} more` : '') +
    ending;
  let shown = parts.length;
  while (shown > 1 && words(shown).length > LIMITS.comment) shown -= 1;
  return words(shown);
}

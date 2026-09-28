import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { StockService } from '@hatti/inventory/public';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  OrderEvents,
  type FulfillmentCreatedPayload,
  type FulfillmentUpdatedPayload,
} from './events.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import type { OrderRecord } from './records.js';
import { LIMITS } from './rules.js';
import {
  fulfillmentLines,
  fulfillments,
  lines,
  type FulfillmentRow,
  type OrderRow,
} from './schema.js';

/** A courier and its tracking number. Replaces what the parcel had; left out clears. */
export interface TrackingInput {
  /** e.g. "TCS", "Leopards", "PostEx". */
  company?: string | null;
  number?: string | null;
  /** Where the customer can follow the parcel: an https URL. */
  url?: string | null;
}

export interface FulfillInput {
  /** Lines and how many of each to ship; everything left to ship if left out. */
  lineItems?: { id: string; quantity: number }[] | null;
  tracking?: TrackingInput | null;
}

/** How many units of a line in a returned parcel go back on the shelf. */
export interface RestockInput {
  lineItemId: string;
  quantity: number;
}

/** A change to an order's parcels: the order after it, and which parcel. */
export interface ParcelResult {
  order: OrderRecord;
  fulfillmentId: string;
}

interface TrackingColumns {
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

function checkTracking(
  check: InputChecker,
  field: string[],
  input: TrackingInput | null | undefined,
): TrackingColumns {
  const trackingCompany = check.text([...field, 'company'], input?.company, { max: 100 });
  const trackingNumber = check.text([...field, 'number'], input?.number, { max: 100 });
  let trackingUrl = check.text([...field, 'url'], input?.url, { max: 2_048 });
  if (trackingUrl !== null) {
    try {
      const url = new URL(trackingUrl);
      if (url.protocol !== 'https:') throw new TypeError('not https');
      trackingUrl = url.toString();
    } catch {
      check.add([...field, 'url'], 'INVALID', 'must be an https:// URL');
      trackingUrl = null;
    }
  }
  return { trackingCompany, trackingNumber, trackingUrl };
}

/** "TCS 1234567890", for the timeline. */
function trackingText(parcel: TrackingColumns): string {
  return [parcel.trackingCompany, parcel.trackingNumber].filter(Boolean).join(' ');
}

function items(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

/** Where an order shows in stock history: "hatti://orders/ord_…". */
function orderReference(orderId: string): string {
  return `hatti://orders/${toPublicId('order', orderId)}`;
}

/**
 * Parcels: shipping an order's items, which takes them out of stock, and what becomes of them.
 * A parcel is delivered, or refused or undeliverable and comes back (return to origin), to be
 * checked in with each item restocked or written off. The order's stage follows its parcels.
 */
@Injectable()
export class FulfillmentService {
  constructor(
    private readonly db: Database,
    private readonly stock: StockService,
  ) {}

  /** Ships items of a confirmed or prepaid order in one parcel. */
  async fulfill(
    tenant: TenantContext,
    orderId: string,
    input: FulfillInput,
  ): Promise<MutationResult<ParcelResult>> {
    const check = new InputChecker();
    const tracking = checkTracking(check, ['input', 'trackingInfo'], input.tracking);
    const requested = (input.lineItems ?? []).map((line, index) => ({
      id: line.id,
      field: ['input', 'lineItems', String(index)],
      quantity: check.integer(['input', 'lineItems', String(index), 'quantity'], line.quantity, {
        min: 1,
        max: LIMITS.quantity,
      }),
    }));
    const seen = new Set<string>();
    for (const line of requested) {
      if (seen.has(line.id)) {
        check.addMessage(line.field, 'INVALID', 'The same line is listed twice');
      }
      seen.add(line.id);
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<ParcelResult>> => {
      const order = await lockOrder(tx, tenant.shopId, orderId);
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be shipped`);
      }
      if (order.confirmationStatus !== 'confirmed' && order.confirmationStatus !== 'not_required') {
        return failOne(['id'], 'INVALID', 'Confirm the order with the customer before shipping it');
      }
      const orderLines = await tx
        .select({
          id: lines.id,
          variantId: lines.variantId,
          quantity: lines.quantity,
          fulfilledQuantity: lines.fulfilledQuantity,
        })
        .from(lines)
        .where(and(eq(lines.shopId, tenant.shopId), eq(lines.orderId, order.id)));
      const byId = new Map(orderLines.map((line) => [line.id, line]));

      const errors: FieldError[] = [];
      const shipping = input.lineItems
        ? requested.flatMap((wanted) => {
            const line = byId.get(wanted.id);
            if (!line) {
              errors.push({
                field: [...wanted.field, 'id'],
                code: 'NOT_FOUND',
                message: 'Line not found on this order',
              });
              return [];
            }
            const left = line.quantity - line.fulfilledQuantity;
            if (wanted.quantity! > left) {
              errors.push({
                field: [...wanted.field, 'quantity'],
                code: 'INVALID',
                message:
                  left === 0 ? 'Everything on this line has shipped' : `Only ${left} left to ship`,
              });
              return [];
            }
            return [{ line, quantity: wanted.quantity! }];
          })
        : orderLines
            .filter((line) => line.quantity > line.fulfilledQuantity)
            .map((line) => ({ line, quantity: line.quantity - line.fulfilledQuantity }));
      if (errors.length > 0) return { ok: false, errors };
      if (shipping.length === 0) {
        return failOne(['id'], 'INVALID', 'Everything on this order has shipped');
      }

      const shipped = await this.stock.fulfill(
        tx,
        tenant,
        shipping.map(({ line, quantity }) => ({
          variantId: line.variantId,
          locationId: order.locationId,
          quantity,
        })),
        { referenceDocumentUri: orderReference(order.id) },
      );
      if (!shipped.ok) throw new Error('Shipping stock cannot fall short');

      const fulfillmentId = newId();
      await tx.insert(fulfillments).values({
        shopId: tenant.shopId,
        id: fulfillmentId,
        orderId: order.id,
        locationId: order.locationId,
        ...tracking,
      });
      await tx.insert(fulfillmentLines).values(
        shipping.map(({ line, quantity }) => ({
          shopId: tenant.shopId,
          fulfillmentId,
          lineId: line.id,
          quantity,
        })),
      );
      await tx.execute(sql`
        UPDATE orders.lines l
           SET fulfilled_quantity = l.fulfilled_quantity + s.quantity
          FROM unnest(${sql.param(shipping.map(({ line }) => line.id))}::uuid[],
                      ${sql.param(shipping.map(({ quantity }) => quantity))}::int[])
               AS s(id, quantity)
         WHERE l.shop_id = ${tenant.shopId} AND l.id = s.id`);

      const updated = await updateOrder(tx, tenant.shopId, order, {});
      const units = shipping.reduce((sum, { quantity }) => sum + quantity, 0);
      const via = trackingText(tracking);
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'fulfilled',
        `Shipped ${items(units)}` + (via ? ` with ${via}` : ''),
      );
      await appendEvent<FulfillmentCreatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.FulfillmentCreated,
        aggregateType: 'fulfillment',
        aggregateId: fulfillmentId,
        payload: {
          orderId: order.id,
          status: 'in_transit',
          trackingCompany: tracking.trackingCompany,
          trackingNumber: tracking.trackingNumber,
          orderStage: updated.stage,
          orderVersion: updated.version,
        },
      });
      return {
        ok: true,
        value: { order: (await loadOrder(tx, tenant.shopId, order.id))!, fulfillmentId },
      };
    });
  }

  /** Sets the parcel's courier, tracking number and link, e.g. once it is booked. */
  async updateTracking(
    tenant: TenantContext,
    fulfillmentId: string,
    input: TrackingInput,
  ): Promise<MutationResult<ParcelResult>> {
    const check = new InputChecker();
    const tracking = checkTracking(check, ['trackingInfo'], input);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, fulfillmentId, async (tx, order, parcel) => {
      await tx
        .update(fulfillments)
        .set({ ...tracking, version: sql`${fulfillments.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, parcel.id)));
      const via = trackingText(tracking);
      return {
        ok: true,
        value: {
          changed: ['tracking'],
          status: parcel.status,
          kind: 'tracking',
          message: via ? `Tracking set to ${via}` : 'Tracking removed',
        },
      };
    });
  }

  /** The courier delivered the parcel. */
  async markDelivered(
    tenant: TenantContext,
    fulfillmentId: string,
  ): Promise<MutationResult<ParcelResult>> {
    return this.#change(tenant, fulfillmentId, async (tx, _order, parcel) => {
      if (parcel.status === 'delivered') return { ok: true, value: null };
      if (parcel.status === 'returned') {
        return failOne(['id'], 'INVALID', 'The parcel already came back');
      }
      await this.#setStatus(tx, tenant.shopId, parcel, 'delivered', 'deliveredAt');
      const via = trackingText(parcel);
      return {
        ok: true,
        value: {
          changed: ['status'],
          status: 'delivered',
          kind: 'delivered',
          message: 'Delivered' + (via ? ` by ${via}` : ''),
        },
      };
    });
  }

  /** The customer refused the parcel, or it could not be delivered: it is coming back. */
  async markReturning(
    tenant: TenantContext,
    fulfillmentId: string,
  ): Promise<MutationResult<ParcelResult>> {
    return this.#change(tenant, fulfillmentId, async (tx, _order, parcel) => {
      if (parcel.status === 'returning') return { ok: true, value: null };
      if (parcel.status === 'delivered') {
        return failOne(
          ['id'],
          'INVALID',
          'A delivered parcel comes back as a customer return, which is not built yet',
        );
      }
      if (parcel.status === 'returned') {
        return failOne(['id'], 'INVALID', 'The parcel already came back');
      }
      await this.#setStatus(tx, tenant.shopId, parcel, 'returning', 'returningAt');
      return {
        ok: true,
        value: {
          changed: ['status'],
          status: 'returning',
          kind: 'returning',
          message: 'Refused or undeliverable: the parcel is coming back',
        },
      };
    });
  }

  /**
   * Checks a parcel that came back into its location. `restock` says how many of each line go
   * back on the shelf; the rest are written off as damaged. Everything is restocked if left out.
   */
  async receiveReturn(
    tenant: TenantContext,
    fulfillmentId: string,
    restock?: RestockInput[] | null,
  ): Promise<MutationResult<ParcelResult>> {
    const check = new InputChecker();
    const requested = (restock ?? []).map((entry, index) => ({
      ...entry,
      field: ['restock', String(index)],
      quantity: check.integer(['restock', String(index), 'quantity'], entry.quantity, {
        min: 0,
        max: LIMITS.quantity,
      }),
    }));
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(tenant, fulfillmentId, async (tx, order, parcel) => {
      if (parcel.status === 'returned') {
        return failOne(['id'], 'INVALID', 'The parcel was already checked back in');
      }
      if (parcel.status === 'delivered') {
        return failOne(
          ['id'],
          'INVALID',
          'A delivered parcel comes back as a customer return, which is not built yet',
        );
      }
      const contents = await tx
        .select({
          lineId: fulfillmentLines.lineId,
          quantity: fulfillmentLines.quantity,
          variantId: lines.variantId,
        })
        .from(fulfillmentLines)
        .innerJoin(
          lines,
          and(eq(lines.shopId, fulfillmentLines.shopId), eq(lines.id, fulfillmentLines.lineId)),
        )
        .where(
          and(
            eq(fulfillmentLines.shopId, tenant.shopId),
            eq(fulfillmentLines.fulfillmentId, parcel.id),
          ),
        );
      const inParcel = new Map(contents.map((line) => [line.lineId, line]));
      const errors: FieldError[] = [];
      const restocked = new Map<string, number>();
      for (const entry of requested) {
        const line = inParcel.get(entry.lineItemId);
        if (!line) {
          errors.push({
            field: [...entry.field, 'lineItemId'],
            code: 'NOT_FOUND',
            message: 'Line not in this parcel',
          });
        } else if (entry.quantity! > line.quantity) {
          errors.push({
            field: [...entry.field, 'quantity'],
            code: 'INVALID',
            message: `Only ${line.quantity} of this line were in the parcel`,
          });
        } else {
          restocked.set(line.lineId, entry.quantity!);
        }
      }
      if (errors.length > 0) return { ok: false, errors };
      const back = contents.map((line) => ({
        ...line,
        restocked: restock ? (restocked.get(line.lineId) ?? 0) : line.quantity,
      }));

      const shelved = back.filter((line) => line.restocked > 0);
      if (shelved.length > 0) {
        const done = await this.stock.restock(
          tx,
          tenant,
          shelved.map((line) => ({
            variantId: line.variantId,
            locationId: parcel.locationId,
            quantity: line.restocked,
          })),
          { referenceDocumentUri: orderReference(order.id) },
        );
        if (!done.ok) throw new Error('Restocking cannot fall short');
      }
      await tx.execute(sql`
        UPDATE orders.fulfillment_lines fl
           SET restocked_quantity = r.quantity
          FROM unnest(${sql.param(back.map((line) => line.lineId))}::uuid[],
                      ${sql.param(back.map((line) => line.restocked))}::int[])
               AS r(line_id, quantity)
         WHERE fl.shop_id = ${tenant.shopId} AND fl.fulfillment_id = ${parcel.id}
           AND fl.line_id = r.line_id`);
      await this.#setStatus(tx, tenant.shopId, parcel, 'returned', 'returnedAt');

      const restockedUnits = back.reduce((sum, line) => sum + line.restocked, 0);
      const writtenOff = back.reduce((sum, line) => sum + line.quantity - line.restocked, 0);
      const parts = [
        restockedUnits > 0 ? `${items(restockedUnits)} back in stock` : null,
        writtenOff > 0 ? `${items(writtenOff)} written off as damaged` : null,
      ].filter(Boolean);
      return {
        ok: true,
        value: {
          changed: ['status'],
          status: 'returned',
          kind: 'returned',
          message: `Parcel checked back in: ${parts.join(', ')}`,
        },
      };
    });
  }

  async #setStatus(
    tx: Tx,
    shopId: string,
    parcel: FulfillmentRow,
    status: FulfillmentRow['status'],
    stamp: 'deliveredAt' | 'returningAt' | 'returnedAt',
  ): Promise<void> {
    await tx
      .update(fulfillments)
      .set({
        status,
        [stamp]: sql`now()`,
        version: sql`${fulfillments.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(fulfillments.shopId, shopId), eq(fulfillments.id, parcel.id)));
  }

  /**
   * Locks the parcel's order, then the parcel, and runs `change`. A change that returns what it
   * did brings the order up to date and records it on the timeline and as an event; one that
   * returns null changed nothing.
   */
  async #change(
    tenant: TenantContext,
    fulfillmentId: string,
    change: (
      tx: Tx,
      order: OrderRow,
      parcel: FulfillmentRow,
    ) => Promise<
      MutationResult<{
        changed: string[];
        status: FulfillmentRow['status'];
        kind: string;
        message: string;
      } | null>
    >,
  ): Promise<MutationResult<ParcelResult>> {
    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<ParcelResult>> => {
      const [found] = await tx
        .select({ orderId: fulfillments.orderId })
        .from(fulfillments)
        .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, fulfillmentId)));
      if (!found) return failOne(['id'], 'NOT_FOUND', 'Fulfillment not found');
      // The order first, as every change to an order locks it first.
      const order = (await lockOrder(tx, tenant.shopId, found.orderId))!;
      const [parcel] = await tx
        .select()
        .from(fulfillments)
        .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, fulfillmentId)))
        .for('update');
      const result = await change(tx, order, parcel!);
      if (!result.ok) return result;
      if (result.value) {
        const updated = await updateOrder(tx, tenant.shopId, order, {});
        await addTimelineEntry(
          tx,
          tenant.shopId,
          order.id,
          tenant.actor,
          result.value.kind,
          result.value.message,
        );
        await appendEvent<FulfillmentUpdatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.FulfillmentUpdated,
          aggregateType: 'fulfillment',
          aggregateId: fulfillmentId,
          payload: {
            orderId: order.id,
            status: result.value.status,
            changed: result.value.changed,
            version: parcel!.version + 1,
            orderStage: updated.stage,
            orderVersion: updated.version,
          },
        });
      }
      return {
        ok: true,
        value: { order: (await loadOrder(tx, tenant.shopId, order.id))!, fulfillmentId },
      };
    });
  }
}

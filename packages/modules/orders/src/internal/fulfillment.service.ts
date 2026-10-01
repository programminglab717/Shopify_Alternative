import {
  InputChecker,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, exactTime, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { StockService } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  OrderEvents,
  type FulfillmentCreatedPayload,
  type FulfillmentUpdatedPayload,
} from './events.js';
import { parcelsByTrackingIn, trackingKey } from './cod-cash.js';
import { addTimelineEntry, loadOrder, lockOrder, updateOrder } from './order-store.js';
import { CLAIM_LIMITS, claimedParcel, parcelWorth, writtenOffWorth } from './parcel-claims.js';
import type { OrderRecord, Page, ParcelClaimRecord } from './records.js';
import { LIMITS, orderName } from './rules.js';
import {
  fulfillmentLines,
  fulfillments,
  lines,
  type FulfillmentRow,
  type OrderRow,
  type ParcelClaimStatusValue,
} from './schema.js';

type NumberRow = { number: number };

type UnitsRow = { units: number };

/** Why a parcel marked lost takes no news from its courier but turning up. */
const LOST = 'The parcel was marked lost: check it back in if it turns up';

type ReturningRow = {
  id: string;
  order_id: string;
  number: number;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | Date;
  returning_at: string | Date;
  returning_at_exactly: string;
  days: number;
  units: number;
};

type LostRow = {
  id: string;
  order_id: string;
  number: number;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | Date;
  lost_at: string | Date;
  lost_at_exactly: string;
  days: number;
  units: number;
  worth: string;
  claim_status: ParcelClaimStatusValue | null;
  claim_amount: string | null;
  claim_paid: string | null;
  claim_note: string | null;
  claimed_at: string | Date | null;
  claim_settled_at: string | Date | null;
};

type ClaimedRow = {
  id: string;
  order_id: string;
  number: number;
  status: 'lost' | 'returned';
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  claim_status: ParcelClaimStatusValue;
  claim_amount: string;
  claim_paid: string | null;
  claim_note: string | null;
  claimed_at: string | Date;
  claim_settled_at: string | Date | null;
  claimed_at_exactly: string;
};

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

/** A parcel on its way back to the shop, refused or undeliverable: for chasing its courier. */
export interface ReturningParcelRecord {
  id: string;
  orderId: string;
  orderNumber: number;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date;
  returningAt: Date;
  /** Where it sorts, for the page after it: `returningAt` to the microsecond, as ISO 8601. */
  returningAtExactly: string;
  /** Whole days since it started coming back. */
  days: number;
  /** Items in it. */
  units: number;
}

/** Which parcels on their way back to list, and from where. */
export interface ReturningParcelsOptions {
  first: number;
  /** The parcel the previous page ended with: its `returningAtExactly` and ID. */
  after?: { returningAt: string; id: string } | null;
  /** One courier's alone, as parcels name it, in any letter case. */
  courier?: string | null;
  /** When "now" is, for the days counted; now if left out. */
  at?: Date;
}

/** A claim on the courier that lost a parcel, as the shop files it (ADR-093). */
export interface ClaimInput {
  /** What to claim, in major units: "2,500"; the parcel's worth if left out. */
  amount?: string | null;
  /** The courier's claim number, or anything else to keep with the claim. */
  note?: string | null;
}

/** What became of a claim, as the shop records it. */
export interface ClaimSettlementInput {
  status: Exclude<ParcelClaimStatusValue, 'open'>;
  /** What the courier paid, in major units: needed when it paid. */
  amount?: string | null;
  /** Why the courier refused it, or anything else to keep; the claim's note stays if left out. */
  note?: string | null;
}

/** A parcel the courier lost, and its claim: for following the claims up. */
export interface LostParcelRecord {
  id: string;
  orderId: string;
  orderNumber: number;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date;
  lostAt: Date;
  /** Where it sorts, for the page after it: `lostAt` to the microsecond, as ISO 8601. */
  lostAtExactly: string;
  /** Whole days since it was marked lost. */
  days: number;
  /** Items in it. */
  units: number;
  /** Minor units: its items at their prices on the order. */
  worth: bigint;
  claim: ParcelClaimRecord | null;
}

/** Lost parcels whose claims are in a state, or which have none yet (`unclaimed`). */
export type LostParcelClaimFilter = 'unclaimed' | ParcelClaimStatusValue;

/** Which lost parcels to list, and from where. */
export interface LostParcelsOptions {
  first: number;
  /** The parcel the previous page ended with: its `lostAtExactly` and ID. */
  after?: { lostAt: string; id: string } | null;
  /** One courier's alone, as parcels name it, in any letter case. */
  courier?: string | null;
  /** Those whose claims are in these states alone; all if left out. */
  claims?: readonly LostParcelClaimFilter[] | null;
  /** When "now" is, for the days counted; now if left out. */
  at?: Date;
}

/**
 * A parcel with a claim on its courier (ADR-093, ADR-098): one it lost, or one that came back
 * with items written off as damaged.
 */
export interface ClaimedParcelRecord {
  id: string;
  orderId: string;
  orderNumber: number;
  status: 'lost' | 'returned';
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  claim: ParcelClaimRecord;
  /** Where it sorts, for the page after it: when it was claimed, to the microsecond, as ISO 8601. */
  claimedAtExactly: string;
}

/** Which claims to list, and from where. */
export interface ParcelClaimsOptions {
  first: number;
  /** The claim the previous page ended with: its `claimedAtExactly` and ID. */
  after?: { claimedAt: string; id: string } | null;
  /** One courier's alone, as parcels name it, in any letter case. */
  courier?: string | null;
  /** Those in these states alone; all if left out. */
  statuses?: readonly ParcelClaimStatusValue[] | null;
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

/** The courier, as the parcel names it: "TCS", or "the courier". */
function courierOf(parcel: { trackingCompany: string | null }): string {
  return parcel.trackingCompany ?? 'the courier';
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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

  /**
   * Ships items of a confirmed or prepaid order in one parcel; a bank-transfer order's, once its
   * money is in.
   */
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
      if (order.stage === 'awaiting_payment') {
        return failOne(
          ['id'],
          'INVALID',
          order.paymentMethod === 'bank_transfer'
            ? 'Mark the order paid once its bank transfer is in'
            : 'Record the advance it asks for once it is in',
        );
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
      if (parcel.status === 'lost') return failOne(['id'], 'INVALID', LOST);
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
      if (parcel.status === 'lost') return failOne(['id'], 'INVALID', LOST);
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
   * Checks a parcel that came back into its location, one marked lost that turned up too.
   * `restock` says how many of each line go back on the shelf; the rest are written off as
   * damaged. Everything is restocked if left out.
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
      // A lost parcel that turned up is owed by no one: its claim, unless paid, is withdrawn.
      const withdrawn =
        parcel.status === 'lost' &&
        (parcel.claimStatus === 'open' || parcel.claimStatus === 'refused');
      if (withdrawn) {
        await tx
          .update(fulfillments)
          .set({ claimStatus: 'withdrawn', claimSettledAt: sql`now()` })
          .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, parcel.id)));
      }

      const restockedUnits = back.reduce((sum, line) => sum + line.restocked, 0);
      const writtenOff = back.reduce((sum, line) => sum + line.quantity - line.restocked, 0);
      const parts = [
        restockedUnits > 0 ? `${items(restockedUnits)} back in stock` : null,
        writtenOff > 0 ? `${items(writtenOff)} written off as damaged` : null,
      ].filter(Boolean);
      const what =
        parcel.status === 'lost'
          ? 'Lost parcel turned up, checked back in'
          : 'Parcel checked back in';
      return {
        ok: true,
        value: {
          changed: withdrawn ? ['status', 'claim'] : ['status'],
          status: 'returned',
          kind: 'returned',
          message:
            `${what}: ${parts.join(', ')}` +
            (withdrawn ? `; its claim on ${courierOf(parcel)} withdrawn` : ''),
        },
      };
    });
  }

  /**
   * The courier lost the parcel, on its way out or back (ADR-072): it is written off, nothing of
   * it restocked, and an order whose every parcel was lost is done, at the `lost` stage, unpaid.
   * Lost before reaching the customer, it never counts as their refusal; refused first, it stays
   * refused. If it turns up, it is checked back in as any parcel that came back.
   */
  async markLost(
    tenant: TenantContext,
    fulfillmentId: string,
  ): Promise<MutationResult<ParcelResult>> {
    return this.#change(tenant, fulfillmentId, async (tx, _order, parcel) => {
      if (parcel.status === 'lost') return { ok: true, value: null };
      if (parcel.status === 'delivered') {
        return failOne(['id'], 'INVALID', 'A delivered parcel cannot be lost');
      }
      if (parcel.status === 'returned') {
        return failOne(['id'], 'INVALID', 'The parcel was already checked back in');
      }
      // Nothing of it goes back on the shelf, unless it turns up.
      const { rows } = await tx.execute<UnitsRow>(sql`
        UPDATE orders.fulfillment_lines SET restocked_quantity = 0
         WHERE shop_id = ${tenant.shopId} AND fulfillment_id = ${parcel.id}
        RETURNING quantity AS units`);
      const units = rows.reduce((sum, row) => sum + row.units, 0);
      await this.#setStatus(tx, tenant.shopId, parcel, 'lost', 'lostAt');
      const via = trackingText(parcel);
      return {
        ok: true,
        value: {
          changed: ['status'],
          status: 'lost',
          kind: 'lost',
          message:
            `Lost by ${via || 'the courier'}` +
            (parcel.status === 'returning' ? ' on its way back' : '') +
            `: ${items(units)} written off`,
        },
      };
    });
  }

  /**
   * Claims a lost parcel's worth from its courier (ADR-093), or what of a parcel that came back
   * was written off as damaged (ADR-098), or `amount`: the claim is the parcel's, open until the
   * courier pays it, in a statement or otherwise, or refuses it, or the shop withdraws it. A
   * parcel has one claim, though one withdrawn may be filed again.
   */
  async claim(
    tenant: TenantContext,
    fulfillmentId: string,
    input: ClaimInput = {},
  ): Promise<MutationResult<ParcelResult>> {
    const check = new InputChecker();
    const amount = check.price(['amount'], input.amount, tenant.currency);
    const note = check.text(['note'], input.note, { max: CLAIM_LIMITS.note });
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, fulfillmentId, async (tx, order, parcel) => {
      if (parcel.status !== 'lost' && parcel.status !== 'returned') {
        return failOne(
          ['id'],
          'INVALID',
          'Only a parcel the courier lost, or one that came back with items written off, is ' +
            'claimed',
        );
      }
      if (parcel.claimStatus !== null && parcel.claimStatus !== 'withdrawn') {
        return failOne(['id'], 'TAKEN', 'The parcel is claimed already');
      }
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      const { rows } = await tx.execute<{ worth: string; written_off: string }>(sql`
        SELECT ${parcelWorth(sql`f`)}::text AS worth,
               ${writtenOffWorth(sql`f`)}::text AS written_off
          FROM orders.fulfillments f
         WHERE f.shop_id = ${tenant.shopId} AND f.id = ${parcel.id}`);
      // A lost parcel is owed whole; one that came back, what of it was written off.
      const owed = BigInt(parcel.status === 'lost' ? rows[0]!.worth : rows[0]!.written_off);
      if (owed === 0n) {
        return failOne(
          ['id'],
          'INVALID',
          'Nothing of the parcel was written off: all of it went back in stock',
        );
      }
      const claimed = amount ?? owed;
      if (claimed <= 0n || claimed > order.total) {
        return failOne(
          ['amount'],
          'INVALID',
          `Give an amount to claim, up to the order's total of ${rupees(order.total)}`,
        );
      }
      await tx
        .update(fulfillments)
        .set({
          claimStatus: 'open',
          claimAmount: claimed,
          claimPaid: null,
          claimNote: note,
          claimedAt: sql`now()`,
          claimSettledAt: null,
          version: sql`${fulfillments.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, parcel.id)));
      return {
        ok: true,
        value: {
          changed: ['claim'],
          status: parcel.status,
          kind: 'claimed',
          message:
            `Claimed ${rupees(claimed)} from ${courierOf(parcel)} for ${claimedParcel(parcel)}` +
            (note ? `: ${note}` : ''),
        },
      };
    });
  }

  /**
   * Records what became of a parcel's claim (ADR-093): the courier paid it, otherwise than in a
   * statement, or refused it, or the shop withdrew it. An open claim is settled so; one the
   * courier refused may still be paid or withdrawn; one paid or withdrawn is done with.
   */
  async settleClaim(
    tenant: TenantContext,
    fulfillmentId: string,
    input: ClaimSettlementInput,
  ): Promise<MutationResult<ParcelResult>> {
    const check = new InputChecker();
    const paying = input.status === 'paid';
    const amount = check.price(['amount'], input.amount, tenant.currency, { required: paying });
    const note = check.text(['note'], input.note, { max: CLAIM_LIMITS.note });
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, fulfillmentId, async (tx, order, parcel) => {
      const claim = parcel.claimStatus;
      if (claim === null) return failOne(['id'], 'INVALID', 'The parcel has no claim');
      if (claim === 'paid' || claim === 'withdrawn' || claim === input.status) {
        return failOne(['id'], 'INVALID', `The claim was ${claim} already`);
      }
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      if (paying && (amount! <= 0n || amount! > order.total)) {
        return failOne(
          ['amount'],
          'INVALID',
          `Give what the courier paid, up to the order's total of ${rupees(order.total)}`,
        );
      }
      await tx
        .update(fulfillments)
        .set({
          claimStatus: input.status,
          claimPaid: paying ? amount : null,
          claimNote: note ?? parcel.claimNote,
          claimSettledAt: sql`now()`,
          version: sql`${fulfillments.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(fulfillments.shopId, tenant.shopId), eq(fulfillments.id, parcel.id)));
      const courier = courierOf(parcel);
      const claimed = claimedParcel(parcel);
      const what =
        input.status === 'paid'
          ? `${capitalized(courier)} paid ${rupees(amount!)} on the claim for ${claimed}`
          : input.status === 'refused'
            ? `${capitalized(courier)} refused the claim for ${claimed}`
            : `Claim on ${courier} for ${claimed} withdrawn`;
      return {
        ok: true,
        value: {
          changed: ['claim'],
          status: parcel.status,
          kind: `claim_${input.status}`,
          message: what + (note ? `: ${note}` : ''),
        },
      };
    });
  }

  /**
   * Checks in the parcel whose label carries `trackingNumber`, as a scanner or a person types it:
   * spaces and letter case ignored, as couriers' statements are matched (ADR-071). It must name
   * one parcel still out; one already checked in, or delivered, says so as by its ID.
   */
  async receiveReturnByTracking(
    tenant: TenantContext,
    trackingNumber: string,
    restock?: RestockInput[] | null,
  ): Promise<MutationResult<ParcelResult>> {
    const key = trackingKey(trackingNumber);
    const field = ['trackingNumber'];
    if (key === '') return failOne(field, 'BLANK', "can't be blank");
    if (key.length > 100) return failOne(field, 'TOO_LONG', 'is too long (maximum 100 characters)');
    const found = await this.db.tenant(tenant.shopId, async (tx) => {
      const parcels = (await parcelsByTrackingIn(tx, tenant.shopId, [key])).get(key) ?? [];
      // A parcel marked lost that turns up is checked in too.
      const out = parcels.filter(
        (parcel) =>
          parcel.status === 'in_transit' ||
          parcel.status === 'returning' ||
          parcel.status === 'lost',
      );
      if (out.length < 2) return { parcels, out, names: [] };
      const { rows } = await tx.execute<NumberRow>(sql`
        SELECT number FROM orders.orders
         WHERE shop_id = ${tenant.shopId}
           AND id = ANY(${sql.param(out.map((parcel) => parcel.orderId))}::uuid[])
         ORDER BY number`);
      return { parcels, out, names: rows.map((row) => orderName(row.number)) };
    });
    if (found.parcels.length === 0) {
      return failOne(field, 'NOT_FOUND', 'No parcel has this tracking number');
    }
    if (found.out.length > 1) {
      return failOne(
        field,
        'INVALID',
        `${found.out.length} parcels still out have this tracking number, of orders ` +
          `${found.names.join(', ')}: check one in from its order`,
      );
    }
    // The one still out; otherwise the latest shipped, to say what became of it.
    const parcel = found.out[0] ?? found.parcels[0]!;
    const result = await this.receiveReturn(tenant, parcel.id, restock);
    if (result.ok) return result;
    return {
      ok: false,
      errors: result.errors.map((error) =>
        error.field.length === 1 && error.field[0] === 'id' ? { ...error, field } : error,
      ),
    };
  }

  /**
   * Parcels on their way back, the longest on its way first, with how many days each has been:
   * those a courier has been slow to bring back come to the top, to chase.
   */
  async returning(
    tenant: TenantContext,
    options: ReturningParcelsOptions,
  ): Promise<Page<ReturningParcelRecord>> {
    const at = options.at ?? new Date();
    const courier = options.courier?.trim() || null;
    const after = options.after;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ReturningRow>(sql`
        SELECT f.id, f.order_id, o.number, f.tracking_company, f.tracking_number, f.tracking_url,
               f.shipped_at, f.returning_at,
               ${exactTime(sql`f.returning_at`)} AS returning_at_exactly,
               floor(extract(epoch FROM ${at.toISOString()}::timestamptz - f.returning_at)
                     / 86400)::int AS days,
               (SELECT coalesce(sum(fl.quantity), 0)::int FROM orders.fulfillment_lines fl
                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id) AS units
          FROM orders.fulfillments f
          JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
         WHERE f.shop_id = ${tenant.shopId} AND f.status = 'returning'
           ${courier === null ? sql`` : sql`AND lower(f.tracking_company) = lower(${courier})`}
           ${
             after
               ? sql`AND (f.returning_at, f.id) > (${after.returningAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY f.returning_at, f.id
         LIMIT ${options.first + 1}`);
      const items = rows.slice(0, options.first).map((row) => ({
        id: row.id,
        orderId: row.order_id,
        orderNumber: row.number,
        trackingCompany: row.tracking_company,
        trackingNumber: row.tracking_number,
        trackingUrl: row.tracking_url,
        shippedAt: new Date(row.shipped_at),
        returningAt: new Date(row.returning_at),
        returningAtExactly: row.returning_at_exactly,
        days: Math.max(0, row.days),
        units: row.units,
      }));
      return { items, hasNextPage: rows.length > options.first };
    });
  }

  /**
   * Parcels the courier lost, the longest lost first, with their worth and their claims: those
   * whose claims are still open, or have none, are the ones to follow up (ADR-093).
   */
  async lost(tenant: TenantContext, options: LostParcelsOptions): Promise<Page<LostParcelRecord>> {
    const at = options.at ?? new Date();
    const courier = options.courier?.trim() || null;
    const after = options.after;
    const claims = options.claims ?? null;
    const statuses = (claims ?? []).filter((claim) => claim !== 'unclaimed');
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<LostRow>(sql`
        SELECT f.id, f.order_id, o.number, f.tracking_company, f.tracking_number, f.tracking_url,
               f.shipped_at, f.lost_at, ${exactTime(sql`f.lost_at`)} AS lost_at_exactly,
               floor(extract(epoch FROM ${at.toISOString()}::timestamptz - f.lost_at)
                     / 86400)::int AS days,
               (SELECT coalesce(sum(fl.quantity), 0)::int FROM orders.fulfillment_lines fl
                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id) AS units,
               ${parcelWorth(sql`f`)}::text AS worth,
               f.claim_status, f.claim_amount::text AS claim_amount,
               f.claim_paid::text AS claim_paid, f.claim_note, f.claimed_at, f.claim_settled_at
          FROM orders.fulfillments f
          JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
         WHERE f.shop_id = ${tenant.shopId} AND f.status = 'lost'
           ${courier === null ? sql`` : sql`AND lower(f.tracking_company) = lower(${courier})`}
           ${
             claims === null
               ? sql``
               : sql`AND (f.claim_status = ANY(${sql.param(statuses)}::text[])
                          ${claims.includes('unclaimed') ? sql`OR f.claim_status IS NULL` : sql``})`
           }
           ${
             after
               ? sql`AND (f.lost_at, f.id) > (${after.lostAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY f.lost_at, f.id
         LIMIT ${options.first + 1}`);
      const items = rows.slice(0, options.first).map((row): LostParcelRecord => ({
        id: row.id,
        orderId: row.order_id,
        orderNumber: row.number,
        trackingCompany: row.tracking_company,
        trackingNumber: row.tracking_number,
        trackingUrl: row.tracking_url,
        shippedAt: new Date(row.shipped_at),
        lostAt: new Date(row.lost_at),
        lostAtExactly: row.lost_at_exactly,
        days: Math.max(0, row.days),
        units: row.units,
        worth: BigInt(row.worth),
        claim:
          row.claim_status === null
            ? null
            : {
                status: row.claim_status,
                amount: BigInt(row.claim_amount!),
                paid: row.claim_paid === null ? null : BigInt(row.claim_paid),
                note: row.claim_note,
                claimedAt: new Date(row.claimed_at!),
                settledAt: row.claim_settled_at === null ? null : new Date(row.claim_settled_at),
              },
      }));
      return { items, hasNextPage: rows.length > options.first };
    });
  }

  /**
   * Parcels with claims on their couriers, lost or come back damaged, the oldest claim first
   * (ADR-098): those still open, or refused, are the ones to follow up.
   */
  async claims(
    tenant: TenantContext,
    options: ParcelClaimsOptions,
  ): Promise<Page<ClaimedParcelRecord>> {
    const courier = options.courier?.trim() || null;
    const { after, statuses } = options;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ClaimedRow>(sql`
        SELECT f.id, f.order_id, o.number, f.status, f.tracking_company, f.tracking_number,
               f.tracking_url, f.claim_status, f.claim_amount::text AS claim_amount,
               f.claim_paid::text AS claim_paid, f.claim_note, f.claimed_at, f.claim_settled_at,
               ${exactTime(sql`f.claimed_at`)} AS claimed_at_exactly
          FROM orders.fulfillments f
          JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
         WHERE f.shop_id = ${tenant.shopId} AND f.claim_status IS NOT NULL
           ${courier === null ? sql`` : sql`AND lower(f.tracking_company) = lower(${courier})`}
           ${statuses ? sql`AND f.claim_status = ANY(${sql.param([...statuses])}::text[])` : sql``}
           ${
             after
               ? sql`AND (f.claimed_at, f.id) > (${after.claimedAt}::timestamptz, ${after.id}::uuid)`
               : sql``
           }
         ORDER BY f.claimed_at, f.id
         LIMIT ${options.first + 1}`);
      const items = rows.slice(0, options.first).map((row): ClaimedParcelRecord => ({
        id: row.id,
        orderId: row.order_id,
        orderNumber: row.number,
        status: row.status,
        trackingCompany: row.tracking_company,
        trackingNumber: row.tracking_number,
        trackingUrl: row.tracking_url,
        claim: {
          status: row.claim_status,
          amount: BigInt(row.claim_amount),
          paid: row.claim_paid === null ? null : BigInt(row.claim_paid),
          note: row.claim_note,
          claimedAt: new Date(row.claimed_at),
          settledAt: row.claim_settled_at === null ? null : new Date(row.claim_settled_at),
        },
        claimedAtExactly: row.claimed_at_exactly,
      }));
      return { items, hasNextPage: rows.length > options.first };
    });
  }

  async #setStatus(
    tx: Tx,
    shopId: string,
    parcel: FulfillmentRow,
    status: FulfillmentRow['status'],
    stamp: 'deliveredAt' | 'returningAt' | 'returnedAt' | 'lostAt',
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

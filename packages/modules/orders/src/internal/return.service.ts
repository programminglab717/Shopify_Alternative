import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { LocationService, StockService } from '@hatti/inventory/public';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { OrderEvents, type ReturnPayload } from './events.js';
import {
  addTimelineEntry,
  loadOrder,
  lockOrder,
  orderReference,
  updateOrder,
} from './order-store.js';
import type { OrderRecord, ReturnRecord } from './records.js';
import { LIMITS, itemName, returnName } from './rules.js';
import {
  lines,
  returnLines,
  returns,
  type OrderRow,
  type ReturnReasonValue,
  type ReturnRow,
  type ReturnStatusValue,
} from './schema.js';

/** Units of one of an order's lines coming back, and why. */
export interface ReturnLineInput {
  lineItemId: string;
  quantity: number;
  reason: ReturnReasonValue;
}

/** A customer return to record (ORD-07, ADR-136). */
export interface ReturnCreateInput {
  orderId: string;
  returnLineItems: ReturnLineInput[];
  /** Where it comes back to; the order's location if left out. */
  locationId?: string | null;
  trackingCompany?: string | null;
  trackingNumber?: string | null;
  note?: string | null;
}

/** Units of a returned line going back in stock as it is checked in; the rest are written off. */
export interface ReturnRestockInput {
  lineItemId: string;
  quantity: number;
}

export interface ReturnResult {
  order: OrderRecord;
  /** The return the change was to. */
  return: ReturnRecord;
}

/** Why each item came back, as the timeline says it. */
const REASON_WORDS: Record<ReturnReasonValue, string> = {
  size_too_small: 'too small',
  size_too_large: 'too large',
  unwanted: 'not wanted',
  not_as_described: 'not as described',
  wrong_item: 'the wrong item',
  defective: 'faulty',
  other: 'another reason',
};

/**
 * Customer returns (ORD-07, ADR-136): a customer sending back items of a delivered parcel, as when
 * a size is wrong. Staff record what comes back and why, and check it in when it arrives, each
 * unit back in stock where it came back to or written off. Every change locks the order first,
 * as every change to an order does. Money given back is a refund of its own.
 */
@Injectable()
export class ReturnService {
  constructor(
    private readonly db: Database,
    private readonly locations: LocationService,
    private readonly stock: StockService,
  ) {}

  /**
   * Records a return of delivered items: units of the order's lines, each no more than were
   * delivered and not on another return already, with why. It comes back to `locationId`, or the
   * order's location, by the courier and tracking number given, if any.
   */
  async create(
    tenant: TenantContext,
    input: ReturnCreateInput,
  ): Promise<MutationResult<ReturnResult>> {
    const check = new InputChecker();
    const entries = input.returnLineItems ?? [];
    if (entries.length === 0) {
      check.addMessage(['input', 'returnLineItems'], 'BLANK', 'Name the items coming back');
    } else if (entries.length > LIMITS.lines) {
      check.add(['input', 'returnLineItems'], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
    const named = new Set<string>();
    const asked = entries.map((entry, index) => {
      const field = ['input', 'returnLineItems', String(index)];
      if (named.has(entry.lineItemId)) {
        check.addMessage([...field, 'lineItemId'], 'INVALID', 'The line item is given twice');
      }
      named.add(entry.lineItemId);
      const quantity = check.integer([...field, 'quantity'], entry.quantity, {
        min: 1,
        max: LIMITS.quantity,
      });
      return { ...entry, quantity: quantity ?? 0, field };
    });
    const trackingCompany = check.text(['input', 'trackingCompany'], input.trackingCompany, {
      max: 100,
    });
    const trackingNumber = check.text(['input', 'trackingNumber'], input.trackingNumber, {
      max: 100,
    });
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    if (!check.ok) return { ok: false, errors: check.errors };
    const { shopId } = tenant;

    return this.db.tenant(shopId, async (tx): Promise<MutationResult<ReturnResult>> => {
      const order = await lockOrder(tx, shopId, input.orderId);
      if (!order) return failOne(['input', 'orderId'], 'NOT_FOUND', 'Order not found');
      const locationId = input.locationId ?? order.locationId;
      const location = (await this.locations.locationsOf(tx, shopId, [locationId])).get(locationId);
      if (!location?.isActive) {
        return failOne(
          ['input', 'locationId'],
          'NOT_FOUND',
          input.locationId
            ? 'Location not found, or not active'
            : "The order's location is not active: say where it comes back to",
        );
      }
      const returnable = await returnableUnits(tx, shopId, order.id);
      const orderLines = await tx
        .select()
        .from(lines)
        .where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
      const byId = new Map(orderLines.map((line) => [line.id, line]));
      const errors: FieldError[] = [];
      for (const entry of asked) {
        const line = byId.get(entry.lineItemId);
        if (!line) {
          errors.push({
            field: [...entry.field, 'lineItemId'],
            code: 'NOT_FOUND',
            message: 'Line item not found on this order',
          });
          continue;
        }
        const left = returnable.get(line.id) ?? 0;
        if (entry.quantity > left) {
          errors.push({
            field: [...entry.field, 'quantity'],
            code: 'INVALID',
            message:
              left === 0
                ? `No "${itemName(line)}" was delivered that is not coming back already`
                : `Only ${left} of "${itemName(line)}" delivered can come back`,
          });
        }
      }
      if (errors.length > 0) return { ok: false, errors };

      const [{ next }] = (
        await tx.execute<{ next: number }>(sql`
          SELECT coalesce(max(number), 0) + 1 AS next
            FROM orders.returns
           WHERE shop_id = ${shopId} AND order_id = ${order.id}`)
      ).rows as [{ next: number }];
      const id = newId();
      const { actorKind, actorId } = actorColumnsOf(tenant.actor);
      const [created] = await tx
        .insert(returns)
        .values({
          shopId,
          id,
          orderId: order.id,
          number: next,
          locationId,
          trackingCompany,
          trackingNumber,
          note,
          actorKind,
          actorId,
        })
        .returning();
      await tx.insert(returnLines).values(
        asked.map((entry) => ({
          shopId,
          returnId: id,
          lineId: entry.lineItemId,
          quantity: entry.quantity,
          reason: entry.reason,
        })),
      );
      const what = asked
        .map((entry) => {
          const line = byId.get(entry.lineItemId)!;
          return `${entry.quantity} × ${itemName(line)}, ${REASON_WORDS[entry.reason]}`;
        })
        .join('; ');
      const via = [trackingCompany, trackingNumber].filter(Boolean).join(' ');
      return this.#changed(tx, tenant, order, created!, {
        type: OrderEvents.ReturnCreated,
        message: clipped(
          `Return ${returnName(order.number, next)} recorded: ${what}` +
            (via ? `; coming back by ${via}` : '') +
            ` to ${location.name}`,
        ),
      });
    });
  }

  /**
   * Checks a return in as it arrives: `restock` says how many of each line go back in stock where
   * it came back to, the rest written off; all of it if left out. It is then closed.
   */
  async receive(
    tenant: TenantContext,
    id: string,
    restock?: ReturnRestockInput[] | null,
  ): Promise<MutationResult<ReturnResult>> {
    const check = new InputChecker();
    const named = new Set<string>();
    const asked = (restock ?? []).map((entry, index) => {
      const field = ['restock', String(index)];
      if (named.has(entry.lineItemId)) {
        check.addMessage([...field, 'lineItemId'], 'INVALID', 'The line item is given twice');
      }
      named.add(entry.lineItemId);
      const quantity = check.integer([...field, 'quantity'], entry.quantity, {
        min: 0,
        max: LIMITS.quantity,
      });
      return { lineItemId: entry.lineItemId, quantity: quantity ?? 0, field };
    });
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(tenant, id, async (tx, order, row) => {
      if (row.status !== 'open') return failOne(['id'], 'INVALID', closedWords(row.status));
      const contents = await tx
        .select({
          lineId: returnLines.lineId,
          quantity: returnLines.quantity,
          variantId: lines.variantId,
        })
        .from(returnLines)
        .innerJoin(
          lines,
          and(eq(lines.shopId, returnLines.shopId), eq(lines.id, returnLines.lineId)),
        )
        .where(and(eq(returnLines.shopId, tenant.shopId), eq(returnLines.returnId, row.id)));
      const inReturn = new Map(contents.map((line) => [line.lineId, line]));
      const errors: FieldError[] = [];
      const restocked = new Map<string, number>();
      for (const entry of asked) {
        const line = inReturn.get(entry.lineItemId);
        if (!line) {
          errors.push({
            field: [...entry.field, 'lineItemId'],
            code: 'NOT_FOUND',
            message: 'Line not in this return',
          });
        } else if (entry.quantity > line.quantity) {
          errors.push({
            field: [...entry.field, 'quantity'],
            code: 'INVALID',
            message: `Only ${line.quantity} of this line are coming back`,
          });
        } else {
          restocked.set(line.lineId, entry.quantity);
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
            locationId: row.locationId,
            quantity: line.restocked,
          })),
          { referenceDocumentUri: orderReference(order.id) },
        );
        if (!done.ok) throw new Error('Restocking cannot fall short');
      }
      await tx.execute(sql`
        UPDATE orders.return_lines rl
           SET restocked_quantity = r.quantity
          FROM unnest(${sql.param(back.map((line) => line.lineId))}::uuid[],
                      ${sql.param(back.map((line) => line.restocked))}::int[])
               AS r(line_id, quantity)
         WHERE rl.shop_id = ${tenant.shopId} AND rl.return_id = ${row.id}
           AND rl.line_id = r.line_id`);
      const [closed] = await tx
        .update(returns)
        .set({ status: 'closed', closedAt: sql`now()` })
        .where(and(eq(returns.shopId, tenant.shopId), eq(returns.id, row.id)))
        .returning();
      const restockedUnits = back.reduce((sum, line) => sum + line.restocked, 0);
      const writtenOff = back.reduce((sum, line) => sum + line.quantity - line.restocked, 0);
      const parts = [
        restockedUnits > 0 ? `${items(restockedUnits)} back in stock` : null,
        writtenOff > 0 ? `${items(writtenOff)} written off` : null,
      ].filter(Boolean);
      return {
        ok: true,
        value: {
          row: closed!,
          type: OrderEvents.ReturnClosed,
          message: `Return ${returnName(order.number, row.number)} checked in: ${parts.join(', ')}`,
        },
      };
    });
  }

  /** Cancels a return still coming back, as when the customer keeps the items after all. */
  async cancel(tenant: TenantContext, id: string): Promise<MutationResult<ReturnResult>> {
    return this.#change(tenant, id, async (tx, order, row) => {
      if (row.status !== 'open') return failOne(['id'], 'INVALID', closedWords(row.status));
      const [cancelled] = await tx
        .update(returns)
        .set({ status: 'cancelled', cancelledAt: sql`now()` })
        .where(and(eq(returns.shopId, tenant.shopId), eq(returns.id, row.id)))
        .returning();
      return {
        ok: true,
        value: {
          row: cancelled!,
          type: OrderEvents.ReturnCancelled,
          message: `Return ${returnName(order.number, row.number)} cancelled: nothing is coming back`,
        },
      };
    });
  }

  /** A change to return `id`: its order locked first, as every change to an order locks it. */
  async #change(
    tenant: TenantContext,
    id: string,
    change: (
      tx: Tx,
      order: OrderRow,
      row: ReturnRow,
    ) => Promise<MutationResult<{ row: ReturnRow; type: ReturnEventType; message: string }>>,
  ): Promise<MutationResult<ReturnResult>> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx): Promise<MutationResult<ReturnResult>> => {
      const [found] = await tx
        .select({ orderId: returns.orderId })
        .from(returns)
        .where(and(eq(returns.shopId, shopId), eq(returns.id, id)));
      if (!found) return failOne(['id'], 'NOT_FOUND', 'Return not found');
      const order = (await lockOrder(tx, shopId, found.orderId))!;
      const [row] = await tx
        .select()
        .from(returns)
        .where(and(eq(returns.shopId, shopId), eq(returns.id, id)))
        .for('update');
      const result = await change(tx, order, row!);
      if (!result.ok) return result;
      return this.#changed(tx, tenant, order, result.value.row, result.value);
    });
  }

  /** Says on the order's timeline and in an event what became of a return, and answers with it. */
  async #changed(
    tx: Tx,
    tenant: TenantContext,
    order: OrderRow,
    row: ReturnRow,
    said: { type: ReturnEventType; message: string },
  ): Promise<MutationResult<ReturnResult>> {
    const { shopId } = tenant;
    const updated = await updateOrder(tx, shopId, order, {});
    await addTimelineEntry(tx, shopId, order.id, tenant.actor, 'return', said.message);
    await appendEvent<ReturnPayload>(tx, shopId, {
      type: said.type,
      aggregateType: 'return',
      aggregateId: row.id,
      payload: {
        orderId: order.id,
        number: row.number,
        status: row.status,
        orderStage: updated.stage,
        orderVersion: updated.version,
      },
    });
    const record = (await loadOrder(tx, shopId, order.id))!;
    return {
      ok: true,
      value: { order: record, return: record.returns.find((each) => each.id === row.id)! },
    };
  }
}

type ReturnEventType =
  | typeof OrderEvents.ReturnCreated
  | typeof OrderEvents.ReturnClosed
  | typeof OrderEvents.ReturnCancelled;

/**
 * Units of each of the order's lines that may come back: delivered, less those on its returns
 * that are not cancelled. A refused parcel comes back as itself.
 */
async function returnableUnits(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<Map<string, number>> {
  const { rows } = await tx.execute<{ line_id: string; units: number }>(sql`
    SELECT d.line_id, (d.units - coalesce(r.units, 0))::int AS units
      FROM (SELECT fl.line_id, sum(fl.quantity) AS units
              FROM orders.fulfillments f
              JOIN orders.fulfillment_lines fl
                ON fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id
             WHERE f.shop_id = ${shopId} AND f.order_id = ${orderId} AND f.status = 'delivered'
             GROUP BY fl.line_id) AS d
      LEFT JOIN (SELECT rl.line_id, sum(rl.quantity) AS units
                   FROM orders.returns rt
                   JOIN orders.return_lines rl
                     ON rl.shop_id = rt.shop_id AND rl.return_id = rt.id
                  WHERE rt.shop_id = ${shopId} AND rt.order_id = ${orderId}
                    AND rt.status <> 'cancelled'
                  GROUP BY rl.line_id) AS r ON r.line_id = d.line_id`);
  return new Map(rows.map((row) => [row.line_id, row.units]));
}

function closedWords(status: ReturnStatusValue): string {
  return status === 'closed' ? 'The return was checked in already' : 'The return was cancelled';
}

function items(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

/** As much of a timeline entry as it holds. */
function clipped(message: string): string {
  return message.length <= LIMITS.comment ? message : `${message.slice(0, LIMITS.comment - 1)}…`;
}

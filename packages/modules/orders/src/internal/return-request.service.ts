import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, exactTime, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { OrderEvents, type ReturnRequestPayload } from './events.js';
import type { LinkProblem } from './links.js';
import { orderSettingsIn } from './order-settings.service.js';
import { addTimelineEntry, loadOrder, lockOrder } from './order-store.js';
import type { OrderRecord, Page } from './records.js';
import { ReturnService, returnableUnits, type ReturnResult } from './return.service.js';
import { LIMITS, itemName, returnName } from './rules.js';
import {
  RETURN_PREFERENCES,
  RETURN_REASONS,
  returnRequestLines,
  returnRequests,
  type OrderRow,
  type ReturnPreferenceValue,
  type ReturnReasonValue,
  type ReturnRequestRow,
  type ReturnRequestStatusValue,
} from './schema.js';

/** The most a shopper writes with what they send back. */
export const RETURN_NOTE_MAX = 500;

/** What the shopper would like for what they send back, as the timeline says it. */
const PREFERENCE_WORDS: Record<ReturnPreferenceValue, string> = {
  exchange: 'another size or item',
  store_credit: 'store credit',
  refund: 'their money back',
};

/** Why each item goes back, as the timeline says it. */
const REASON_WORDS: Record<ReturnReasonValue, string> = {
  size_too_small: 'too small',
  size_too_large: 'too large',
  unwanted: 'not wanted',
  not_as_described: 'not as described',
  wrong_item: 'the wrong item',
  defective: 'faulty',
  other: 'another reason',
};

/** Units of one of an order's lines a shopper asked to send back, and why. */
export interface ReturnRequestLineRecord {
  lineItemId: string;
  title: string;
  variantTitle: string;
  quantity: number;
  reason: ReturnReasonValue;
}

/** A return a shopper asked for from their order's page (ORD-08, ADR-675). */
export interface ReturnRequestRecord {
  id: string;
  orderId: string;
  orderNumber: number;
  status: ReturnRequestStatusValue;
  preference: ReturnPreferenceValue;
  /** The shopper's own words; empty for none, or once their data was erased. */
  note: string;
  /** Why the shop declined it, as the shopper is told; null unless declined. */
  declineReason: string | null;
  /** The return it became, once approved. */
  returnId: string | null;
  lines: ReturnRequestLineRecord[];
  createdAt: Date;
  /** Where it sorts, for the page after it: `createdAt` to the microsecond, as ISO 8601. */
  createdAtExactly: string;
  decidedAt: Date | null;
}

/** What a delivered order's page offers of returns (ADR-675). */
export interface ReturnOffer {
  /**
   * Until when the shopper may ask, the shop's days from the last delivery; null when the shop
   * takes none now, or the order was never delivered.
   */
  until: Date | null;
  /** Units of each line they may ask to send back now; empty while one waits. */
  lines: { lineItemId: string; title: string; variantTitle: string; units: number }[];
  /** Their latest request, as it stands; null for none. */
  latest: ReturnRequestRecord | null;
}

/** What the shopper posted: by line, how many and why; what they would like; their words. */
export interface ReturnRequestForm {
  lines: ReadonlyMap<string, { quantity: string; reason: string }>;
  preference: string;
  note: string;
}

export interface ReturnRequestsOptions {
  /** Those of one status; all if left out. */
  status?: ReturnRequestStatusValue | null;
  /** One order's alone. */
  orderId?: string | null;
  first: number;
  /** The request the previous page ended with: its `createdAtExactly` and ID. */
  after?: { createdAt: string; id: string } | null;
}

/**
 * What a delivered order's page offers of returns at `now`: what may go back until when, and the
 * shopper's latest request; null where the shop takes none and they asked for none.
 */
export async function returnOfferIn(
  tx: Tx,
  shopId: string,
  order: OrderRecord,
  now: Date = new Date(),
): Promise<ReturnOffer | null> {
  const [latest] = await requestsIn(tx, shopId, { orderId: order.id, first: 1, newestFirst: true });
  const { returnWindowDays } = await orderSettingsIn(tx, shopId);
  if (returnWindowDays === null || order.status === 'cancelled') {
    return latest ? { until: null, lines: [], latest } : null;
  }
  const { rows } = await tx.execute<{ delivered: string | Date | null }>(sql`
    SELECT max(delivered_at) AS delivered FROM orders.fulfillments
     WHERE shop_id = ${shopId} AND order_id = ${order.id} AND status = 'delivered'`);
  const delivered = rows[0]?.delivered;
  if (!delivered) return latest ? { until: null, lines: [], latest } : null;
  const until = new Date(new Date(delivered).getTime() + returnWindowDays * 86_400_000);
  const waiting = latest?.status === 'requested';
  const units = waiting || until <= now ? new Map() : await returnableUnits(tx, shopId, order.id);
  const lines = order.lines.flatMap((line) => {
    const left = units.get(line.id) ?? 0;
    return left > 0
      ? [{ lineItemId: line.id, title: line.title, variantTitle: line.variantTitle, units: left }]
      : [];
  });
  return { until, lines, latest: latest ?? null };
}

/**
 * The shopper asks, through their order's page, to send back what `form` says of the order
 * locked in `tx` (ADR-675): within the shop's days of its delivery, units it may still take back,
 * each with why, and what they would like for it. One waits at a time. It goes on the order's
 * timeline, by the system. Why not, if it was not taken.
 */
export async function requestReturnLocked(
  tx: Tx,
  shopId: string,
  order: OrderRow,
  form: ReturnRequestForm,
): Promise<LinkProblem | null> {
  const record = (await loadOrder(tx, shopId, order.id))!;
  const offer = await returnOfferIn(tx, shopId, record);
  if (offer?.latest?.status === 'requested') return { kind: 'return', reason: 'waiting' };
  if (!offer?.until || offer.until <= new Date() || offer.lines.length === 0) {
    return { kind: 'too_late', action: 'return' };
  }
  const chosen: {
    line: ReturnOffer['lines'][number];
    quantity: number;
    reason: ReturnReasonValue;
  }[] = [];
  for (const line of offer.lines) {
    const posted = form.lines.get(line.lineItemId);
    const quantity = Number(posted?.quantity ?? '0');
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    const reason = posted?.reason as ReturnReasonValue;
    if (!RETURN_REASONS.includes(reason)) return { kind: 'return', reason: 'reason' };
    chosen.push({ line, quantity: Math.min(quantity, line.units), reason });
  }
  if (chosen.length === 0) return { kind: 'return', reason: 'none' };
  const preference = form.preference as ReturnPreferenceValue;
  if (!RETURN_PREFERENCES.includes(preference)) return { kind: 'return', reason: 'preference' };
  const note = form.note.trim().slice(0, RETURN_NOTE_MAX);
  const id = newId();
  await tx.insert(returnRequests).values({ shopId, id, orderId: order.id, preference, note });
  await tx.insert(returnRequestLines).values(
    chosen.map((each) => ({
      shopId,
      requestId: id,
      lineId: each.line.lineItemId,
      quantity: each.quantity,
      reason: each.reason,
    })),
  );
  const what = chosen
    .map((each) => `${each.quantity} × ${itemName(each.line)}, ${REASON_WORDS[each.reason]}`)
    .join('; ');
  await addTimelineEntry(
    tx,
    shopId,
    order.id,
    'system',
    'return_requested',
    clipped(
      `The customer asked to return ${what}, for ${PREFERENCE_WORDS[preference]}` +
        (note ? `: "${note}"` : ''),
    ),
  );
  await appendEvent<ReturnRequestPayload>(tx, shopId, {
    type: OrderEvents.ReturnRequested,
    aggregateType: 'return_request',
    aggregateId: id,
    payload: { orderId: order.id, status: 'requested', returnId: null },
  });
  return null;
}

/**
 * Returns shoppers ask for from their orders' pages (ORD-08, ADR-675): listed for staff, the
 * oldest waiting first, and approved, becoming the return staff record (ADR-136), or declined,
 * saying why. Each decision locks the order first, as every change to an order does.
 */
@Injectable()
export class ReturnRequestService {
  constructor(
    private readonly db: Database,
    private readonly returns: ReturnService,
  ) {}

  list(tenant: TenantContext, options: ReturnRequestsOptions): Promise<Page<ReturnRequestRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const items = await requestsIn(tx, tenant.shopId, { ...options, first: options.first + 1 });
      return { items: items.slice(0, options.first), hasNextPage: items.length > options.first };
    });
  }

  /**
   * Approves a waiting request: it becomes a return of what the shopper asked to send back,
   * coming back to `locationId` or the order's location, as staff record one, the shopper's
   * choice and words in its note. Units the order cannot take back now, as when staff recorded
   * them since, refuse it.
   */
  async approve(
    tenant: TenantContext,
    id: string,
    options: { locationId?: string | null } = {},
  ): Promise<MutationResult<ReturnResult & { request: ReturnRequestRecord }>> {
    return this.#decide(tenant, id, async (tx, order, request) => {
      const lines = await tx
        .select()
        .from(returnRequestLines)
        .where(
          and(eq(returnRequestLines.shopId, tenant.shopId), eq(returnRequestLines.requestId, id)),
        )
        .orderBy(asc(returnRequestLines.lineId));
      const created = await this.returns.createLocked(tx, tenant, order, {
        asked: lines.map((line) => ({
          lineItemId: line.lineId,
          quantity: line.quantity,
          reason: line.reason,
          field: ['id'],
        })),
        locationId: options.locationId ?? null,
        trackingCompany: null,
        trackingNumber: null,
        note: clipped(
          `Asked by the customer, for ${PREFERENCE_WORDS[request.preference]}` +
            (request.note ? `: "${request.note}"` : ''),
          LIMITS.note,
        ),
        exchange: [],
        exchangeShipping: 0n,
      });
      if (!created.ok) return created;
      return {
        ok: true,
        value: {
          set: { status: 'approved' as const, returnId: created.value.return.id },
          type: OrderEvents.ReturnRequestApproved,
          message: `Approved the customer's return request, as ${returnName(order.number, created.value.return.number)}`,
          result: created.value,
        },
      };
    });
  }

  /** Declines a waiting request, saying why, as the shopper is told. */
  async decline(
    tenant: TenantContext,
    id: string,
    reason: string,
  ): Promise<MutationResult<{ request: ReturnRequestRecord }>> {
    const check = new InputChecker();
    const why = check.text(['reason'], reason, { max: RETURN_NOTE_MAX });
    if (check.ok && !why) check.addMessage(['reason'], 'BLANK', 'Say why, as the customer is told');
    if (!check.ok) return { ok: false, errors: check.errors };
    const done = await this.#decide(tenant, id, async () => ({
      ok: true,
      value: {
        set: { status: 'declined' as const, declineReason: why! },
        type: OrderEvents.ReturnRequestDeclined,
        message: clipped(`Declined the customer's return request: ${why}`),
        result: {},
      },
    }));
    return done.ok ? { ok: true, value: { request: done.value.request } } : done;
  }

  /** A decision on waiting request `id`, its order locked first. */
  async #decide<R>(
    tenant: TenantContext,
    id: string,
    decide: (
      tx: Tx,
      order: OrderRow,
      request: ReturnRequestRow,
    ) => Promise<
      MutationResult<{
        set: Partial<ReturnRequestRow> & { status: 'approved' | 'declined' };
        type: string;
        message: string;
        result: R;
      }>
    >,
  ): Promise<MutationResult<NonNullable<R> & { request: ReturnRequestRecord }>> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const [found] = await tx
        .select({ orderId: returnRequests.orderId })
        .from(returnRequests)
        .where(and(eq(returnRequests.shopId, shopId), eq(returnRequests.id, id)));
      if (!found) return failOne(['id'], 'NOT_FOUND', 'Return request not found');
      const order = (await lockOrder(tx, shopId, found.orderId))!;
      const [request] = await tx
        .select()
        .from(returnRequests)
        .where(and(eq(returnRequests.shopId, shopId), eq(returnRequests.id, id)))
        .for('update');
      if (request!.status !== 'requested') {
        return failOne(['id'], 'INVALID', `The request was ${request!.status} already`);
      }
      const decided = await decide(tx, order, request!);
      if (!decided.ok) return decided;
      const { actorKind, actorId } = actorColumnsOf(tenant.actor);
      await tx
        .update(returnRequests)
        .set({
          ...decided.value.set,
          decidedActorKind: actorKind,
          decidedActorId: actorId,
          decidedAt: sql`now()`,
        })
        .where(and(eq(returnRequests.shopId, shopId), eq(returnRequests.id, id)));
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        tenant.actor,
        `return_${decided.value.set.status}`,
        decided.value.message,
      );
      await appendEvent<ReturnRequestPayload>(tx, shopId, {
        type: decided.value.type,
        aggregateType: 'return_request',
        aggregateId: id,
        payload: {
          orderId: order.id,
          status: decided.value.set.status,
          returnId: decided.value.set.returnId ?? null,
        },
      });
      const [record] = await requestsIn(tx, shopId, { id, first: 1 });
      return {
        ok: true,
        value: { ...(decided.value.result as NonNullable<R>), request: record! },
      };
    });
  }
}

/** Requests as staff and shoppers see them, the oldest first unless asked otherwise. */
async function requestsIn(
  tx: Tx,
  shopId: string,
  options: ReturnRequestsOptions & { id?: string; newestFirst?: boolean },
): Promise<ReturnRequestRecord[]> {
  const { after } = options;
  const order = options.newestFirst ? sql`DESC` : sql`ASC`;
  const { rows } = await tx.execute<{
    id: string;
    order_id: string;
    order_number: number;
    status: ReturnRequestStatusValue;
    preference: ReturnPreferenceValue;
    note: string;
    decline_reason: string | null;
    return_id: string | null;
    created_at: string | Date;
    created_at_exactly: string;
    decided_at: string | Date | null;
    lines: ReturnRequestLineRecord[];
  }>(sql`
    SELECT rq.id, rq.order_id, o.number AS order_number, rq.status, rq.preference, rq.note,
           rq.decline_reason, rq.return_id, rq.created_at,
           ${exactTime(sql`rq.created_at`)} AS created_at_exactly, rq.decided_at,
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'lineItemId', l.id, 'title', l.title, 'variantTitle', l.variant_title,
                     'quantity', rl.quantity, 'reason', rl.reason) ORDER BY l.position, l.id),
                   '[]'::jsonb)
              FROM orders.return_request_lines rl
              JOIN orders.lines l ON l.shop_id = rl.shop_id AND l.id = rl.line_id
             WHERE rl.shop_id = rq.shop_id AND rl.request_id = rq.id) AS lines
      FROM orders.return_requests rq
      JOIN orders.orders o ON o.shop_id = rq.shop_id AND o.id = rq.order_id
     WHERE rq.shop_id = ${shopId}
       ${options.id ? sql`AND rq.id = ${options.id}` : sql``}
       ${options.status ? sql`AND rq.status = ${options.status}` : sql``}
       ${options.orderId ? sql`AND rq.order_id = ${options.orderId}` : sql``}
       ${
         after
           ? sql`AND (rq.created_at, rq.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
           : sql``
       }
     ORDER BY rq.created_at ${order}, rq.id ${order}
     LIMIT ${options.first}`);
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    status: row.status,
    preference: row.preference,
    note: row.note,
    declineReason: row.decline_reason,
    returnId: row.return_id,
    lines: row.lines,
    createdAt: new Date(row.created_at),
    createdAtExactly: row.created_at_exactly,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at),
  }));
}

/** As much of a timeline entry, or a note, as it holds. */
function clipped(message: string, max: number = LIMITS.comment): string {
  return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
}

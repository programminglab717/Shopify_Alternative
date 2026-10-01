import {
  InputChecker,
  failOne,
  shopProfile,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  callingMinutesBefore,
  callingTimeFrom,
  callingWindowsIn,
  isCallingTime,
  type CallingWindow,
} from './calling-hours.js';
import { OrderEvents, type OrderUpdatedPayload } from './events.js';
import { orderSettingsIn } from './order-settings.service.js';
import {
  actorColumns,
  addTimelineEntry,
  loadOrders,
  lockOrder,
  updateOrder,
} from './order-store.js';
import type { OrderRecord } from './records.js';
import {
  confirmationCalls,
  orders,
  type ConfirmationCallOutcomeValue,
  type OrderRow,
} from './schema.js';

/** The Confirmation Desk's timings and limits (COD-04, ADR-073). */
export const CONFIRMATION_DESK = {
  /** How long an agent keeps the order they took, in minutes. */
  claimMinutes: 15,
  /** When an unanswered order is due again, in minutes, unless the agent says. */
  retryMinutes: 120,
  /** Unanswered calls after which the customer could not be reached. */
  unansweredForNoResponse: 3,
  /** How far ahead a call may be put off, in days. */
  maxDelayDays: 7,
  /** A note on a call, in characters. */
  note: 500,
} as const;

/** A call made to confirm an order, short of confirming or cancelling it. */
export interface ConfirmationCallRecord {
  outcome: ConfirmationCallOutcomeValue;
  callBackAt: Date | null;
  note: string;
  createdAt: Date;
}

/** An order waiting for its customer to confirm it, as the queue deals it out. */
export interface ConfirmationQueueItem {
  order: OrderRecord;
  unansweredCalls: number;
  /** When it fell due: when it was placed, or when it was due again after a call. */
  dueAt: Date;
  lastCall: ConfirmationCallRecord | null;
  /** Taken by an agent until then; null while no one has it. */
  claimedUntil: Date | null;
  /** Whether whoever asks is the one who took it. */
  claimedByCaller: boolean;
  /**
   * Waiting for its first call longer than the shop's target allows, counting calling hours
   * (COD-05, ADR-091).
   */
  overdue: boolean;
}

/** Whether the desk calls customers now, by the shop's calling hours, and when it next does. */
export interface ConfirmationCalling {
  callingNow: boolean;
  /** When calling hours next open, while they are closed; null while open, or without hours. */
  opensAt: Date | null;
}

export interface ConfirmationQueue extends ConfirmationCalling {
  /** Due now, the most urgent first; at most `first`. */
  items: ConfirmationQueueItem[];
  /** Due now, taken or not. */
  dueCount: number;
  /** To be called again later. */
  laterCount: number;
  /** Of those due, waiting for their first call longer than the shop's target allows. */
  overdueCount: number;
}

export interface ConfirmationCallInput {
  outcome: ConfirmationCallOutcomeValue;
  /** When to call again: required to call back; for no answer, in two hours if left out. */
  callBackAt?: Date | null;
  note?: string | null;
}

// Types rather than interfaces: rows of `execute` must be records.
type QueueRow = {
  id: string;
  unanswered_calls: number;
  due_at: string | Date;
  /** Not called yet: due since it was placed. */
  uncalled: boolean;
  claimed_by_kind: 'app' | 'staff' | null;
  claimed_by: string | null;
  claimed_until: string | Date | null;
};

type CallRow = {
  order_id: string;
  outcome: ConfirmationCallOutcomeValue;
  call_back_at: string | Date | null;
  note: string;
  created_at: string | Date;
};

type CountRow = { due: number; later: number; overdue: number };

/** Orders waiting for their customers to confirm them: the queue's. */
const IN_QUEUE = sql`o.status = 'open' AND o.stage = 'needs_confirmation'`;

const DUE_AT = sql`coalesce(o.confirmation_due_at, o.created_at)`;

/** What the queue reads of an order. */
const QUEUE_COLUMNS = sql`o.id, o.unanswered_calls, ${DUE_AT} AS due_at,
  o.confirmation_due_at IS NULL AS uncalled, o.claimed_by_kind, o.claimed_by, o.claimed_until`;

/**
 * The most urgent first: orders of high value, as the shop's risk policy sets it, then those due
 * longest, then the riskier.
 */
const PRIORITY = sql`(o.risk_reasons @> '[{"code": "high_value"}]'::jsonb) DESC, ${DUE_AT},
                     o.risk_score DESC NULLS LAST, o.id`;

/**
 * The Confirmation Desk (COD-04): the queue of orders waiting for their customers to confirm
 * them, dealt out to agents one at a time, the most urgent first, and the calls made to them.
 * Confirming and cancelling are the order's own (`OrderService`); an order leaves the queue with
 * them.
 */
@Injectable()
export class ConfirmationDeskService {
  constructor(private readonly db: Database) {}

  /** The orders due for a call now, the most urgent first, and how many wait for later. */
  async queue(
    tenant: TenantContext,
    options: { first: number; at?: Date },
  ): Promise<ConfirmationQueue> {
    const now = options.at ?? new Date();
    const at = now.toISOString();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const policy = await deskPolicyIn(tx, tenant.shopId, now);
      const overdueBefore = overdueBeforeOf(policy, now);
      const { rows } = await tx.execute<QueueRow>(sql`
        SELECT ${QUEUE_COLUMNS}
          FROM orders.orders o
         WHERE o.shop_id = ${tenant.shopId} AND ${IN_QUEUE} AND ${DUE_AT} <= ${at}::timestamptz
         ORDER BY ${PRIORITY}
         LIMIT ${options.first}`);
      const overdue = overdueBefore
        ? sql`o.confirmation_due_at IS NULL AND o.created_at < ${overdueBefore.toISOString()}::timestamptz`
        : sql`false`;
      const { rows: counts } = await tx.execute<CountRow>(sql`
        SELECT count(*) FILTER (WHERE ${DUE_AT} <= ${at}::timestamptz)::int AS due,
               count(*) FILTER (WHERE ${DUE_AT} > ${at}::timestamptz)::int AS later,
               count(*) FILTER (WHERE ${overdue})::int AS overdue
          FROM orders.orders o
         WHERE o.shop_id = ${tenant.shopId} AND ${IN_QUEUE}`);
      return {
        ...callingOf(policy, now),
        items: await itemsOf(tx, tenant, rows, now, overdueBefore),
        dueCount: counts[0]?.due ?? 0,
        laterCount: counts[0]?.later ?? 0,
        overdueCount: counts[0]?.overdue ?? 0,
      };
    });
  }

  /** Whether the desk calls customers at `at`, by the shop's calling hours, and when it next does. */
  async calling(tenant: TenantContext, at: Date = new Date()): Promise<ConfirmationCalling> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      callingOf(await deskPolicyIn(tx, tenant.shopId, at), at),
    );
  }

  /**
   * Deals the caller the most urgent order due that no one else has taken, theirs for
   * {@link CONFIRMATION_DESK.claimMinutes} minutes, so that no two agents call the same customer:
   * the one they took already, while they have it and it still waits. Null when none is due, or
   * outside the shop's calling hours.
   */
  async next(tenant: TenantContext, at: Date = new Date()): Promise<ConfirmationQueueItem | null> {
    const { kind, id: me } = whoIs(tenant.actor);
    const now = at.toISOString();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const policy = await deskPolicyIn(tx, tenant.shopId, at);
      if (!callingOf(policy, at).callingNow) return null;
      const mine = sql`o.claimed_by_kind = ${kind} AND o.claimed_by = ${me}::uuid`;
      // Locked as orders are for any change, those another agent is taking passed over.
      const { rows } = await tx.execute<QueueRow>(sql`
        SELECT ${QUEUE_COLUMNS}
          FROM orders.orders o
         WHERE o.shop_id = ${tenant.shopId} AND ${IN_QUEUE} AND ${DUE_AT} <= ${now}::timestamptz
           AND (o.claimed_until IS NULL OR o.claimed_until <= ${now}::timestamptz OR ${mine})
         ORDER BY (${mine} AND o.claimed_until > ${now}::timestamptz) DESC NULLS LAST, ${PRIORITY}
         LIMIT 1
         FOR UPDATE OF o SKIP LOCKED`);
      const row = rows[0];
      if (!row) return null;
      const until = new Date(at.getTime() + CONFIRMATION_DESK.claimMinutes * 60_000);
      // The queue's, not the order's: no new version, timeline entry or event.
      await tx
        .update(orders)
        .set({ claimedByKind: kind, claimedBy: me, claimedUntil: until })
        .where(and(eq(orders.shopId, tenant.shopId), eq(orders.id, row.id)));
      const claimed = { ...row, claimed_by_kind: kind, claimed_by: me, claimed_until: until };
      const [item] = await itemsOf(tx, tenant, [claimed], at, overdueBeforeOf(policy, at));
      return item ?? null;
    });
  }

  /**
   * Records a call made to confirm an order that did not settle it: no answer, due again in two
   * hours, or when calling hours next open if that is outside them, or when the agent says, and
   * after three the customer could not be reached; asked to be called back, due then; or a wrong
   * number, which holds the order for the shop's review. The order is let go for the next agent.
   */
  async recordCall(
    tenant: TenantContext,
    orderId: string,
    input: ConfirmationCallInput,
    at: Date = new Date(),
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const note = check.text(['note'], input.note, { max: CONFIRMATION_DESK.note }) ?? '';
    const callBackAt = input.callBackAt ?? null;
    const latest = at.getTime() + CONFIRMATION_DESK.maxDelayDays * 86_400_000;
    if (input.outcome === 'call_back' && !callBackAt) {
      check.addMessage(['callBackAt'], 'BLANK', 'Say when to call back');
    } else if (callBackAt && (callBackAt <= at || callBackAt.getTime() > latest)) {
      check.addMessage(
        ['callBackAt'],
        'INVALID',
        `A call can be put off until later, within ${CONFIRMATION_DESK.maxDelayDays} days`,
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<OrderRecord>> => {
      const order = await lockOrder(tx, tenant.shopId, orderId);
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      if (
        order.status !== 'open' ||
        (order.stage !== 'needs_confirmation' && order.stage !== 'needs_review')
      ) {
        return failOne(['id'], 'INVALID', 'Only an order waiting to be confirmed takes calls');
      }
      await tx.insert(confirmationCalls).values({
        shopId: tenant.shopId,
        id: newId(),
        orderId,
        outcome: input.outcome,
        callBackAt,
        note,
        ...actorColumns(tenant.actor),
      });
      const dueAgain = callBackAt ?? (await retryAtIn(tx, tenant.shopId, at));
      const { changes, message } = callChanges(order, input.outcome, dueAgain);
      const updated = await updateOrder(tx, tenant.shopId, order, {
        ...changes,
        claimedByKind: null,
        claimedBy: null,
        claimedUntil: null,
      });
      // The note stays with the call, which erasure clears; the timeline keeps how it went.
      await addTimelineEntry(tx, tenant.shopId, order.id, tenant.actor, 'called', message);
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          changed:
            updated.confirmationStatus === order.confirmationStatus
              ? ['confirmationCall']
              : ['confirmationCall', 'confirmationStatus'],
          stage: updated.stage,
          version: updated.version,
        },
      });
      const [record] = await loadOrders(tx, tenant.shopId, {
        where: sql`o.id = ${order.id}`,
      });
      return { ok: true, value: record! };
    });
  }
}

/**
 * What a call's outcome changes on the order, due again at `dueAgain` if it is, and what its
 * timeline says.
 */
function callChanges(
  order: OrderRow,
  outcome: ConfirmationCallOutcomeValue,
  dueAgain: Date,
): { changes: Partial<OrderRow>; message: string } {
  switch (outcome) {
    case 'no_answer': {
      const unanswered = order.unansweredCalls + 1;
      const unreachable =
        unanswered >= CONFIRMATION_DESK.unansweredForNoResponse &&
        order.confirmationStatus === 'pending';
      return {
        changes: {
          unansweredCalls: unanswered,
          confirmationDueAt: dueAgain,
          ...(unreachable ? { confirmationStatus: 'no_response' as const } : {}),
        },
        message:
          `Called, no answer (${unanswered} unanswered)` +
          (unreachable ? ': the customer could not be reached' : ''),
      };
    }
    case 'call_back':
      return {
        changes: { confirmationDueAt: dueAgain },
        message: 'Called: the customer asked to be called back',
      };
    case 'wrong_number': {
      const held = order.confirmationStatus !== 'needs_review';
      return {
        changes: held ? { confirmationStatus: 'needs_review' } : {},
        message: 'Called: wrong number' + (held ? ', held for review' : ''),
      };
    }
  }
}

/**
 * The desk's policy around `at` (COD-05, ADR-091): the windows of the shop's calling hours, from
 * as far back as its first-call target can reach to two days ahead, or null for any time; and
 * that target.
 */
interface DeskPolicy {
  windows: CallingWindow[] | null;
  firstCallMinutes: number | null;
}

async function deskPolicyIn(tx: Tx, shopId: string, at: Date): Promise<DeskPolicy> {
  const { callingHours: hours, firstCallMinutes } = await orderSettingsIn(tx, shopId);
  if (!hours) return { windows: null, firstCallMinutes };
  const { timezone } = await shopProfile(tx, shopId);
  const back = Math.ceil((firstCallMinutes ?? 0) / (hours.closes - hours.opens)) + 1;
  const windows = await callingWindowsIn(tx, hours, timezone, at, { back, ahead: 2 });
  return { windows, firstCallMinutes };
}

/**
 * When an order unanswered at `at` is due again: in {@link CONFIRMATION_DESK.retryMinutes}
 * minutes, or when the shop's calling hours next open if that is outside them.
 */
async function retryAtIn(tx: Tx, shopId: string, at: Date): Promise<Date> {
  const retry = new Date(at.getTime() + CONFIRMATION_DESK.retryMinutes * 60_000);
  const { windows } = await deskPolicyIn(tx, shopId, at);
  return windows ? (callingTimeFrom(windows, retry) ?? retry) : retry;
}

function callingOf(policy: DeskPolicy, at: Date): ConfirmationCalling {
  if (!policy.windows || isCallingTime(policy.windows, at)) {
    return { callingNow: true, opensAt: null };
  }
  return { callingNow: false, opensAt: callingTimeFrom(policy.windows, at) };
}

/**
 * Orders placed before this and not called yet have waited longer than the shop's first-call
 * target, counting calling hours; null without a target.
 */
function overdueBeforeOf(policy: DeskPolicy, at: Date): Date | null {
  if (policy.firstCallMinutes === null) return null;
  return policy.windows
    ? callingMinutesBefore(policy.windows, at, policy.firstCallMinutes)
    : new Date(at.getTime() - policy.firstCallMinutes * 60_000);
}

/** Who an actor is, as a claim names them. */
function whoIs(actor: Actor): { kind: 'app' | 'staff'; id: string } {
  return actor.kind === 'app'
    ? { kind: 'app', id: actor.tokenId }
    : { kind: 'staff', id: actor.userId };
}

/**
 * The queue's rows as items: their orders, the last call made to each, and whether it waited too
 * long for its first: placed before `overdueBefore` and not called yet.
 */
async function itemsOf(
  tx: Tx,
  tenant: TenantContext,
  rows: readonly QueueRow[],
  at: Date,
  overdueBefore: Date | null,
): Promise<ConfirmationQueueItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const records = await loadOrders(tx, tenant.shopId, {
    where: sql`o.id = ANY(${sql.param(ids)}::uuid[])`,
  });
  const byId = new Map(records.map((record) => [record.id, record]));
  const { rows: calls } = await tx.execute<CallRow>(sql`
    SELECT DISTINCT ON (order_id) order_id, outcome, call_back_at, note, created_at
      FROM orders.confirmation_calls
     WHERE shop_id = ${tenant.shopId} AND order_id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY order_id, id DESC`);
  const lastCalls = new Map(calls.map((call) => [call.order_id, call]));
  const { kind, id: me } = whoIs(tenant.actor);
  return rows.map((row) => {
    const call = lastCalls.get(row.id);
    const claimedUntil = row.claimed_until ? new Date(row.claimed_until) : null;
    const held = claimedUntil !== null && claimedUntil > at;
    return {
      order: byId.get(row.id)!,
      unansweredCalls: row.unanswered_calls,
      dueAt: new Date(row.due_at),
      lastCall: call
        ? {
            outcome: call.outcome,
            callBackAt: call.call_back_at ? new Date(call.call_back_at) : null,
            note: call.note,
            createdAt: new Date(call.created_at),
          }
        : null,
      claimedUntil: held ? claimedUntil : null,
      claimedByCaller: held && row.claimed_by_kind === kind && row.claimed_by === me,
      overdue: row.uncalled && overdueBefore !== null && new Date(row.due_at) < overdueBefore,
    };
  });
}

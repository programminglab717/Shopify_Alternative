import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, appendEvents } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderAssignedPayload, type OrderUpdatedPayload } from './events.js';
import { orderSettingsIn } from './order-settings.service.js';
import { addTimelineEntry } from './order-store.js';

/** How long a shift at the Confirmation Desk lasts, in hours (ADR-654). */
export const DESK_DUTY = { hours: { min: 1, max: 12 }, defaultHours: 8 } as const;

/** A member of staff on duty at the desk, until when, and how many orders wait on them. */
export interface DeskDutyRecord {
  staffMemberId: string;
  name: string;
  startedAt: Date;
  endsAt: Date;
  /** Their orders still waiting to be confirmed. */
  waiting: number;
}

type DutyRow = {
  staff_member_id: string;
  name: string;
  started_at: string;
  ends_at: string;
  waiting: number;
};

const WAITING = sql`(SELECT count(*)::int FROM orders.orders o
                      WHERE o.shop_id = d.shop_id AND o.assignee_id = d.staff_member_id
                        AND o.status = 'open' AND o.stage = 'needs_confirmation')`;

/**
 * Who is on duty at the Confirmation Desk (ADR-654): members of staff start a shift of some hours
 * there, and end it when they leave the desk. Where the shop shares new orders out, each order
 * placed that needs a call is given to one of them ({@link shareOutIn}).
 */
@Injectable()
export class DeskDutyService {
  constructor(private readonly db: Database) {}

  /** Those on duty at `at`, the soonest to end first. */
  onDuty(tenant: TenantContext, at: Date = new Date()): Promise<DeskDutyRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<DutyRow>(sql`
        SELECT d.staff_member_id, d.name, d.started_at, d.ends_at, ${WAITING} AS waiting
          FROM orders.desk_duty d
         WHERE d.shop_id = ${tenant.shopId} AND d.ends_at > ${at.toISOString()}::timestamptz
         ORDER BY d.ends_at, d.name`);
      return rows.map(toRecord);
    });
  }

  /**
   * Starts the caller's shift, or moves its end: `hours` from `at`. `name` is theirs, for the
   * timelines of the orders they are given. Staff alone: no order is given to an app.
   */
  async start(
    tenant: TenantContext,
    name: string,
    hours: number,
    at: Date = new Date(),
  ): Promise<MutationResult<DeskDutyRecord>> {
    if (tenant.actor.kind !== 'staff') {
      return failOne(['hours'], 'INVALID', 'Members of staff go on duty, not apps');
    }
    if (!Number.isInteger(hours) || hours < DESK_DUTY.hours.min || hours > DESK_DUTY.hours.max) {
      return failOne(
        ['hours'],
        'INVALID',
        `A shift lasts ${DESK_DUTY.hours.min} to ${DESK_DUTY.hours.max} hours`,
      );
    }
    const userId = tenant.actor.userId;
    const endsAt = new Date(at.getTime() + hours * 3_600_000);
    return this.db.tenant(tenant.shopId, async (tx) => {
      // A shift still running keeps when it started; one that ended starts again.
      const { rows } = await tx.execute<DutyRow>(sql`
        INSERT INTO orders.desk_duty AS d (shop_id, staff_member_id, name, started_at, ends_at)
        VALUES (${tenant.shopId}, ${userId}, ${name.trim().slice(0, 200) || 'Agent'},
                ${at.toISOString()},
                ${endsAt.toISOString()})
        ON CONFLICT (shop_id, staff_member_id) DO UPDATE
           SET name = excluded.name, ends_at = excluded.ends_at,
               started_at = CASE WHEN d.ends_at > excluded.started_at THEN d.started_at
                                 ELSE excluded.started_at END
        RETURNING d.staff_member_id, d.name, d.started_at, d.ends_at, ${WAITING} AS waiting`);
      return { ok: true, value: toRecord(rows[0]!) };
    });
  }

  /**
   * Ends the caller's shift. The orders they were given stay theirs, unless they `handOver` those
   * still waiting to be confirmed (ADR-656): each goes to whoever else is on duty with the fewest
   * waiting, as a new order would. With no one else on duty they stay. Returns how many went.
   */
  async end(tenant: TenantContext, options: { handOver?: boolean } = {}): Promise<number> {
    if (tenant.actor.kind !== 'staff') return 0;
    const userId = tenant.actor.userId;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const leaver = await endDutyIn(tx, tenant.shopId, userId);
      if (!options.handOver) return 0;
      const { rows: waiting } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM orders.orders
         WHERE shop_id = ${tenant.shopId} AND assignee_id = ${userId}
           AND status = 'open' AND stage = 'needs_confirmation'
         ORDER BY created_at, id
           FOR UPDATE`);
      let handed = 0;
      for (const { id } of waiting) {
        const agent = await nextOnDuty(tx, tenant.shopId);
        if (!agent) break;
        const { rows } = await tx.execute<Pick<OrderUpdatedPayload, 'stage' | 'version'>>(sql`
          UPDATE orders.orders
             SET assignee_id = ${agent.staff_member_id}, assigned_at = now(),
                 version = version + 1, updated_at = now()
           WHERE shop_id = ${tenant.shopId} AND id = ${id}
          RETURNING stage, version`);
        const order = rows[0]!;
        await addTimelineEntry(
          tx,
          tenant.shopId,
          id,
          tenant.actor,
          'assigned',
          `Handed over ${leaver ? `by ${leaver} ` : ''}to ${agent.name}, on duty at the Confirmation Desk`,
        );
        await appendEvents(tx, tenant.shopId, [
          {
            type: OrderEvents.OrderUpdated,
            aggregateType: 'order',
            aggregateId: id,
            payload: {
              changed: ['assignee'],
              stage: order.stage,
              version: order.version,
            } satisfies OrderUpdatedPayload,
          },
          {
            // For the worker to tell them (ADR-191).
            type: OrderEvents.OrderAssigned,
            aggregateType: 'order',
            aggregateId: id,
            payload: {
              assigneeId: agent.staff_member_id,
              assignedBy: userId,
              stage: order.stage as OrderAssignedPayload['stage'],
              version: order.version,
            } satisfies OrderAssignedPayload,
          },
        ]);
        handed += 1;
      }
      return handed;
    });
  }
}

/**
 * Ends a member of staff's shift at the desk, if they are on one, as they leave it or the shop:
 * the name they were on duty under, if they were.
 */
export async function endDutyIn(
  tx: Tx,
  shopId: string,
  staffMemberId: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ name: string }>(sql`
    DELETE FROM orders.desk_duty WHERE shop_id = ${shopId} AND staff_member_id = ${staffMemberId}
    RETURNING name`);
  return rows[0]?.name ?? null;
}

/**
 * Gives an order just placed that needs a call to an agent on duty, where the shop shares new
 * orders out (ADR-654): the one with the fewest orders waiting to be confirmed, then the one given
 * one longest ago. Nothing where no one is on duty, or the order is given to someone already.
 * The order keeps its version: it is given in the transaction that places it.
 */
export async function shareOutIn(
  tx: Tx,
  shopId: string,
  order: { id: string; stage: string; version: number; assigneeId: string | null },
): Promise<void> {
  if (order.stage !== 'needs_confirmation' || order.assigneeId !== null) return;
  if (!(await orderSettingsIn(tx, shopId)).shareNewOrders) return;
  const agent = await nextOnDuty(tx, shopId);
  if (!agent) return;
  await tx.execute(sql`
    UPDATE orders.orders SET assignee_id = ${agent.staff_member_id}, assigned_at = now()
     WHERE shop_id = ${shopId} AND id = ${order.id}`);
  await addTimelineEntry(
    tx,
    shopId,
    order.id,
    'system',
    'assigned',
    `Assigned to ${agent.name}, on duty at the Confirmation Desk`,
  );
  // For the worker to tell them (ADR-191); no one gave it but the shop's rule.
  await appendEvent<OrderAssignedPayload>(tx, shopId, {
    type: OrderEvents.OrderAssigned,
    aggregateType: 'order',
    aggregateId: order.id,
    payload: {
      assigneeId: agent.staff_member_id,
      assignedBy: null,
      stage: order.stage as OrderAssignedPayload['stage'],
      version: order.version,
    },
  });
}

/**
 * The agent on duty to give the next order to: the one with the fewest waiting to be confirmed,
 * then the one given one longest ago. Locked, so that orders given at once are dealt one after
 * another; marked as given one now.
 */
async function nextOnDuty(
  tx: Tx,
  shopId: string,
): Promise<{ staff_member_id: string; name: string } | undefined> {
  const { rows } = await tx.execute<{ staff_member_id: string; name: string }>(sql`
    SELECT d.staff_member_id, d.name
      FROM orders.desk_duty d
     WHERE d.shop_id = ${shopId} AND d.ends_at > now()
     ORDER BY ${WAITING}, d.last_given_at NULLS FIRST, d.started_at, d.staff_member_id
     LIMIT 1
       FOR UPDATE OF d`);
  const agent = rows[0];
  if (agent) {
    await tx.execute(sql`
      UPDATE orders.desk_duty SET last_given_at = clock_timestamp()
       WHERE shop_id = ${shopId} AND staff_member_id = ${agent.staff_member_id}`);
  }
  return agent;
}

function toRecord(row: DutyRow): DeskDutyRecord {
  return {
    staffMemberId: row.staff_member_id,
    name: row.name,
    startedAt: new Date(row.started_at),
    endsAt: new Date(row.ends_at),
    waiting: Number(row.waiting),
  };
}

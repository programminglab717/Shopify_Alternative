import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  COD_HEALTH_LIMITS,
  DELIVERY,
  PARCELS,
  deliveryOf,
  type CodDeliveryTally,
  type DeliveryRow,
} from './cod-health.service.js';

export interface AgentPerformanceInput {
  /** Work done at or after this… */
  from: Date;
  /** …and before this. */
  before: Date;
  /** Agents at most, those who settled most orders first. */
  first: number;
}

/** How one agent of the Confirmation Desk did over a period: a staff member, or an app. */
export interface AgentPerformanceRow {
  agent: { kind: 'staff' | 'app'; id: string };
  /** Orders they confirmed. */
  confirmed: number;
  /** Orders they cancelled before anyone confirmed them, as when the customer declined. */
  cancelled: number;
  /** Their calls that settled nothing, by how they went. */
  calls: { noAnswer: number; callBack: number; wrongNumber: number };
  /** The hours of the shop's day in which they did any of it. */
  activeHours: number;
  /** How the parcels of the orders they confirmed went, as they stand now. */
  delivery: CodDeliveryTally;
}

type WorkRow = {
  actor_kind: 'staff' | 'app';
  actor_id: string;
  confirmed: number;
  cancelled: number;
  no_answer: number;
  call_back: number;
  wrong_number: number;
  active_hours: number;
};

type AgentDeliveryRow = DeliveryRow & { actor_kind: 'staff' | 'app'; actor_id: string };

/**
 * Agents' performance (COD-11): what each agent of the Confirmation Desk did over a period, from
 * the calls it keeps (ADR-073) and the confirmations and cancellations on orders' timelines, with
 * who made them; and how the orders they confirmed turned out, as COD health counts parcels
 * (ADR-060). Staff and apps alike, each by who they are; customers confirming through their
 * links are no one's work. Worked out when asked; nothing is stored.
 */
@Injectable()
export class AgentPerformanceService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    input: AgentPerformanceInput,
  ): Promise<MutationResult<AgentPerformanceRow[]>> {
    const span = input.before.getTime() - input.from.getTime();
    if (span <= 0) return failOne(['before'], 'INVALID', 'Before must be later than from');
    if (span > COD_HEALTH_LIMITS.days * 86_400_000) {
      return failOne(
        ['before'],
        'INVALID',
        `Agents' performance covers at most ${COD_HEALTH_LIMITS.days} days at a time`,
      );
    }
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      // Confirmed by an agent, or cancelled while it waited to be confirmed; the conditions on
      // the timeline are its index's, which finds them by when.
      const settled = sql`e.shop_id = ${shopId}
        AND e.kind IN ('confirmed', 'cancelled') AND e.actor_kind IN ('staff', 'app')
        AND e.created_at >= ${input.from} AND e.created_at < ${input.before}
        AND e.actor_id IS NOT NULL`;
      const { rows: work } = await tx.execute<WorkRow>(sql`
        WITH work AS (
          SELECT e.actor_kind, e.actor_id, e.kind AS what, e.order_id, e.created_at
            FROM orders.order_events e
            JOIN orders.orders o ON o.shop_id = e.shop_id AND o.id = e.order_id
           WHERE ${settled}
             AND (e.kind = 'confirmed'
                  OR (o.confirmed_at IS NULL AND o.confirmation_status <> 'not_required'))
          UNION ALL
          SELECT c.actor_kind, c.actor_id, c.outcome, c.order_id, c.created_at
            FROM orders.confirmation_calls c
           WHERE c.shop_id = ${shopId} AND c.actor_kind IN ('staff', 'app')
             AND c.actor_id IS NOT NULL
             AND c.created_at >= ${input.from} AND c.created_at < ${input.before}
        )
        SELECT actor_kind, actor_id::text,
               count(DISTINCT order_id) FILTER (WHERE what = 'confirmed')::int AS confirmed,
               count(DISTINCT order_id) FILTER (WHERE what = 'cancelled')::int AS cancelled,
               count(*) FILTER (WHERE what = 'no_answer')::int AS no_answer,
               count(*) FILTER (WHERE what = 'call_back')::int AS call_back,
               count(*) FILTER (WHERE what = 'wrong_number')::int AS wrong_number,
               count(DISTINCT date_trunc('hour', created_at AT TIME ZONE ${timezone}))::int
                 AS active_hours
          FROM work
         GROUP BY actor_kind, actor_id`);
      const { rows: deliveries } = await tx.execute<AgentDeliveryRow>(sql`
        SELECT e.actor_kind, e.actor_id::text, NULL AS key, ${DELIVERY}
          FROM orders.order_events e
          JOIN orders.orders o ON o.shop_id = e.shop_id AND o.id = e.order_id
          ${PARCELS}
         WHERE ${settled} AND e.kind = 'confirmed'
         GROUP BY e.actor_kind, e.actor_id`);
      const keyOf = (row: { actor_kind: string; actor_id: string }) =>
        `${row.actor_kind}:${row.actor_id}`;
      const parcels = new Map(deliveries.map((row) => [keyOf(row), row]));
      return {
        ok: true,
        value: work
          .map((row) => ({
            agent: { kind: row.actor_kind, id: row.actor_id },
            confirmed: row.confirmed,
            cancelled: row.cancelled,
            calls: {
              noAnswer: row.no_answer,
              callBack: row.call_back,
              wrongNumber: row.wrong_number,
            },
            activeHours: row.active_hours,
            delivery: deliveryOf(parcels.get(keyOf(row))),
          }))
          .sort(
            (a, b) =>
              b.confirmed + b.cancelled - (a.confirmed + a.cancelled) ||
              callsOf(b) - callsOf(a) ||
              a.agent.id.localeCompare(b.agent.id),
          )
          .slice(0, input.first),
      };
    });
  }
}

/** The calls of an agent's that settled nothing. */
function callsOf(row: AgentPerformanceRow): number {
  return row.calls.noAnswer + row.calls.callBack + row.calls.wrongNumber;
}

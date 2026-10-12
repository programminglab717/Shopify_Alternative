import { failOne, shopProfile, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { COD_HEALTH_LIMITS } from './cod-health.service.js';

export interface PackerPerformanceInput {
  /** Packing done at or after this… */
  from: Date;
  /** …and before this. */
  before: Date;
  /** Packers at most, those who packed most orders first. */
  first: number;
  /** This staff member's own packing alone, as a packer sees it; all packers without it. */
  onlyStaff?: string;
}

/** How one packer did over a period: a staff member, or an app. */
export interface PackerPerformanceRow {
  packer: { kind: 'staff' | 'app'; id: string };
  /** Orders they marked as packed that are packed still, or have gone on to ship. */
  packed: number;
  /** The units in those orders, as their items stand now. */
  units: number;
  /** The hours of the shop's day in which they marked any order as packed. */
  activeHours: number;
}

type PackerRow = {
  actor_kind: 'staff' | 'app';
  actor_id: string;
  packed: number;
  units: number;
  active_hours: number;
};

/**
 * Packers' performance (APP-04, COD-11): the orders each member of staff, or app, marked as packed
 * over a period, from the orders' timelines, which say who packed each and when (ADR-376). An
 * order counts for whoever packed it last, and only while nobody has unpacked it since: packing
 * undone is no one's work. Orders shipped without being marked as packed are not counted; their
 * packing has no one's name on it. Worked out when asked; nothing is stored.
 */
@Injectable()
export class PackerPerformanceService {
  constructor(private readonly db: Database) {}

  async report(
    tenant: TenantContext,
    input: PackerPerformanceInput,
  ): Promise<MutationResult<PackerPerformanceRow[]>> {
    const span = input.before.getTime() - input.from.getTime();
    if (span <= 0) return failOne(['before'], 'INVALID', 'Before must be later than from');
    if (span > COD_HEALTH_LIMITS.days * 86_400_000) {
      return failOne(
        ['before'],
        'INVALID',
        `Packers' performance covers at most ${COD_HEALTH_LIMITS.days} days at a time`,
      );
    }
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      const { timezone } = await shopProfile(tx, shopId);
      // The conditions on the timeline are its index's, which finds packing by when.
      const { rows } = await tx.execute<PackerRow>(sql`
        WITH packing AS (
          SELECT e.actor_kind, e.actor_id, e.order_id, e.created_at,
                 NOT EXISTS (
                   SELECT 1 FROM orders.order_events later
                    WHERE later.shop_id = e.shop_id AND later.order_id = e.order_id
                      AND later.kind = 'unpacked' AND later.created_at >= e.created_at
                 ) AS stands
            FROM orders.order_events e
           WHERE e.shop_id = ${shopId} AND e.kind = 'packed'
             AND e.actor_kind IN ('staff', 'app') AND e.actor_id IS NOT NULL
             AND e.created_at >= ${input.from} AND e.created_at < ${input.before}
             ${input.onlyStaff ? sql`AND e.actor_kind = 'staff' AND e.actor_id = ${input.onlyStaff}` : sql``}
        ),
        packed AS (
          SELECT DISTINCT actor_kind, actor_id, order_id FROM packing WHERE stands
        ),
        units AS (
          SELECT p.actor_kind, p.actor_id, count(DISTINCT p.order_id)::int AS packed,
                 coalesce(sum(l.quantity), 0)::int AS units
            FROM packed p
            LEFT JOIN orders.lines l ON l.shop_id = ${shopId} AND l.order_id = p.order_id
           GROUP BY p.actor_kind, p.actor_id
        ),
        hours AS (
          SELECT actor_kind, actor_id,
                 count(DISTINCT date_trunc('hour', created_at AT TIME ZONE ${timezone}))::int
                   AS active_hours
            FROM packing
           GROUP BY actor_kind, actor_id
        )
        SELECT h.actor_kind, h.actor_id::text, coalesce(u.packed, 0) AS packed,
               coalesce(u.units, 0) AS units, h.active_hours
          FROM hours h
          LEFT JOIN units u ON u.actor_kind = h.actor_kind AND u.actor_id = h.actor_id`);
      return {
        ok: true,
        value: rows
          .map((row) => ({
            packer: { kind: row.actor_kind, id: row.actor_id },
            packed: row.packed,
            units: row.units,
            activeHours: row.active_hours,
          }))
          .sort(
            (a, b) =>
              b.packed - a.packed || b.units - a.units || a.packer.id.localeCompare(b.packer.id),
          )
          .slice(0, input.first),
      };
    });
  }
}

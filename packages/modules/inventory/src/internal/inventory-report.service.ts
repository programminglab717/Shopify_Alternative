import type { TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** The periods an inventory report covers, in days (ANL-05, ADR-455). */
export const INVENTORY_REPORT_DAYS = [7, 30, 90] as const;

/** How many variants a report lists, at most. */
export const INVENTORY_REPORT_LIMIT = 250;

/**
 * What a report's variants are listed by; `stock`, every variant, the most on hand first, is
 * custom reports' (ADR-910).
 */
export type InventoryReportSort = 'sell_through' | 'slowest' | 'stockouts' | 'stock';

/** Stock by how long ago it last sold: within 30 days, 31 to 60, 61 to 90, more, or never. */
export const AGEING_BUCKETS = [
  'days_0_30',
  'days_31_60',
  'days_61_90',
  'over_90',
  'never',
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** One variant in an inventory report. */
export interface InventoryReportRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  /** At all the shop's locations, now. */
  onHand: number;
  available: number;
  /** Units sold in the period: committed to orders, less those released, and sold at the till. */
  sold: number;
  /**
   * Of what it had to sell, sold plus what is available now, the share sold, in percent; null for
   * none. Units sold but not yet shipped are on hand still, so on hand would count them twice.
   */
  sellThrough: number | null;
  /** When it last sold; null when it never did. */
  lastSoldAt: Date | null;
  /** Whole days since then; null when it never sold. */
  daysSinceSale: number | null;
  /**
   * Days it had none for sale in the period, to one decimal, and how many times it ran out then:
   * at the location of its where it was out longest.
   */
  daysOut: number;
  stockouts: number;
  /** What one costs the shop; null when the shop gave no cost. */
  cost: bigint | null;
}

/** Stock on hand last sold within one bucket of days. */
export interface AgeingRecord {
  bucket: AgeingBucket;
  variants: number;
  units: number;
  /** Units times cost, of those with one. */
  value: bigint;
  unitsWithoutCost: number;
}

export interface InventoryReportRecord {
  days: number;
  since: Date;
  /** Units sold in the period, and on hand now, of the shop's tracked variants. */
  sold: number;
  onHand: number;
  sellThrough: number | null;
  /** Variants for sale with none available now. */
  outNow: number;
  /** Variants that ran out, or were out, at some time in the period. */
  ranOut: number;
  ageing: AgeingRecord[];
  /** The variants, listed by the sort asked for, up to the number asked for. */
  rows: InventoryReportRow[];
}

const DAY_MS = 86_400_000;

/** A share in percent, to one decimal; null with nothing to share. */
function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part * 1000) / whole) / 10 : null;
}

/**
 * Inventory reports (ANL-05, ADR-455), worked out from the stock ledger when asked, for the shop's
 * tracked variants of products not archived: what sold of what there was to sell over a period;
 * how long ago the stock on hand last sold, with what it cost; and what ran out, and for how long.
 */
@Injectable()
export class InventoryReportService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  async report(
    tenant: TenantContext,
    options: { days: number; sort: InventoryReportSort; first: number },
    at: Date = new Date(),
  ): Promise<InventoryReportRecord> {
    const since = new Date(at.getTime() - options.days * DAY_MS);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        variant_id: string;
        on_hand: number;
        available: number;
        sold: number;
        last_sold_at: string | Date | null;
        seconds_out: number;
        stockouts: number;
      }>(sql`
        WITH tracked AS (
          SELECT variant_id FROM inventory.items WHERE shop_id = ${tenant.shopId} AND tracked
        ),
        stock AS (
          SELECT l.variant_id, sum(l.on_hand)::int AS on_hand, sum(l.available)::int AS available
            FROM inventory.levels l JOIN tracked t USING (variant_id)
           WHERE l.shop_id = ${tenant.shopId}
           GROUP BY l.variant_id
        ),
        sales AS (
          SELECT m.variant_id,
                 GREATEST(coalesce(sum(CASE WHEN a.reason = 'sold' THEN -m.delta ELSE m.delta END)
                   FILTER (WHERE m.created_at >= ${since.toISOString()}), 0), 0)::int AS sold,
                 max(m.created_at)
                   FILTER (WHERE (a.reason = 'committed' AND m.delta > 0) OR a.reason = 'sold')
                   AS last_sold_at
            FROM inventory.movements m
            JOIN inventory.adjustments a ON a.shop_id = m.shop_id AND a.id = m.adjustment_id
           WHERE m.shop_id = ${tenant.shopId}
             -- Orders' units as they were committed, and the till's as it sold them (ADR-872).
             AND ((m.quantity_name = 'committed' AND a.reason IN ('committed', 'commitment_released'))
                  OR (m.quantity_name = 'on_hand' AND a.reason = 'sold'))
             AND m.created_at <= ${at.toISOString()}
           GROUP BY m.variant_id
        ),
        steps AS (
          SELECT m.variant_id, m.location_id, m.created_at, m.available_after,
                 lag(m.available_after) OVER w AS before,
                 coalesce(lead(m.created_at) OVER w, ${at.toISOString()}::timestamptz) AS until
            FROM inventory.movements m JOIN tracked t USING (variant_id)
           WHERE m.shop_id = ${tenant.shopId} AND m.created_at <= ${at.toISOString()}
          WINDOW w AS (PARTITION BY m.variant_id, m.location_id ORDER BY m.created_at, m.id)
        ),
        outs AS (
          SELECT variant_id, location_id,
                 coalesce(sum(extract(epoch FROM until - GREATEST(created_at, ${since.toISOString()}::timestamptz)))
                   FILTER (WHERE available_after <= 0 AND until > ${since.toISOString()}), 0) AS seconds,
                 count(*) FILTER (WHERE available_after <= 0 AND coalesce(before, 1) > 0
                                   AND created_at >= ${since.toISOString()})::int AS times
            FROM steps
           GROUP BY variant_id, location_id
        ),
        worst AS (
          SELECT DISTINCT ON (variant_id) variant_id, seconds, times
            FROM outs ORDER BY variant_id, seconds DESC, times DESC
        )
        SELECT t.variant_id, coalesce(s.on_hand, 0) AS on_hand, coalesce(s.available, 0) AS available,
               coalesce(x.sold, 0) AS sold, x.last_sold_at,
               coalesce(w.seconds, 0)::float8 AS seconds_out, coalesce(w.times, 0) AS stockouts
          FROM tracked t
          LEFT JOIN stock s USING (variant_id)
          LEFT JOIN sales x USING (variant_id)
          LEFT JOIN worst w USING (variant_id)`);
      const snapshots = await this.variants.snapshotsOf(
        tx,
        tenant.shopId,
        rows.map((row) => row.variant_id),
      );
      const all: InventoryReportRow[] = [];
      for (const row of rows) {
        const variant = snapshots.get(row.variant_id);
        if (!variant || variant.productStatus === 'archived') continue;
        const lastSoldAt = row.last_sold_at === null ? null : new Date(row.last_sold_at);
        all.push({
          variantId: row.variant_id,
          productId: variant.productId,
          productTitle: variant.productTitle,
          variantTitle: variant.variantTitle,
          sku: variant.sku,
          onHand: row.on_hand,
          available: row.available,
          sold: row.sold,
          sellThrough: percent(row.sold, row.sold + Math.max(row.available, 0)),
          lastSoldAt,
          daysSinceSale:
            lastSoldAt === null ? null : Math.floor((at.getTime() - lastSoldAt.getTime()) / DAY_MS),
          daysOut: Math.floor((Number(row.seconds_out) / 86_400) * 10) / 10,
          stockouts: row.stockouts,
          cost: variant.cost,
        });
      }
      const sold = all.reduce((sum, row) => sum + row.sold, 0);
      const onHand = all.reduce((sum, row) => sum + Math.max(row.onHand, 0), 0);
      const available = all.reduce((sum, row) => sum + Math.max(row.available, 0), 0);
      const ageing = AGEING_BUCKETS.map((bucket) => ({
        bucket,
        variants: 0,
        units: 0,
        value: 0n,
        unitsWithoutCost: 0,
      }));
      for (const row of all) {
        if (row.onHand <= 0) continue;
        const days = row.daysSinceSale;
        const into =
          ageing[days === null ? 4 : days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3]!;
        into.variants += 1;
        into.units += row.onHand;
        if (row.cost === null) into.unitsWithoutCost += row.onHand;
        else into.value += row.cost * BigInt(row.onHand);
      }
      return {
        days: options.days,
        since,
        sold,
        onHand,
        sellThrough: percent(sold, sold + available),
        outNow: all.filter((row) => row.available <= 0).length,
        ranOut: all.filter((row) => row.daysOut > 0 || row.stockouts > 0).length,
        ageing,
        rows: sorted(all, options.sort).slice(0, options.first),
      };
    });
  }
}

/** The report's variants as asked: each list leaves out those it says nothing of. */
function sorted(rows: InventoryReportRow[], sort: InventoryReportSort): InventoryReportRow[] {
  const byTitle = (a: InventoryReportRow, b: InventoryReportRow) =>
    a.productTitle.localeCompare(b.productTitle) || a.variantTitle.localeCompare(b.variantTitle);
  switch (sort) {
    case 'sell_through':
      // What sold, the best sellers first.
      return rows
        .filter((row) => row.sold > 0)
        .sort((a, b) => b.sellThrough! - a.sellThrough! || b.sold - a.sold || byTitle(a, b));
    case 'slowest':
      // Stock on hand, what never sold first, then what sold longest ago.
      return rows
        .filter((row) => row.onHand > 0)
        .sort(
          (a, b) =>
            (b.daysSinceSale ?? Infinity) - (a.daysSinceSale ?? Infinity) ||
            b.onHand - a.onHand ||
            byTitle(a, b),
        );
    case 'stockouts':
      // What was out, the longest first.
      return rows
        .filter((row) => row.daysOut > 0 || row.stockouts > 0)
        .sort((a, b) => b.daysOut - a.daysOut || b.stockouts - a.stockouts || byTitle(a, b));
    case 'stock':
      // Every variant, the most on hand first, then what sold most.
      return rows.sort((a, b) => b.onHand - a.onHand || b.sold - a.sold || byTitle(a, b));
  }
}

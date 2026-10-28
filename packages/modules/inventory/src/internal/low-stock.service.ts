import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import {
  addDays,
  daysInSeason,
  pkDayOf,
  pkSeasonsBetween,
  previousPkSeason,
  type PkSeason,
} from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InventoryEvents, type InventorySettingsUpdatedPayload } from './events.js';
import type { Page } from './records.js';

export const LOW_STOCK_THRESHOLD = {
  /** What a shop calls low until it says otherwise. */
  default: 5,
  min: 0,
  max: 10_000,
} as const;

/** How far back what a variant sold is counted, to say how fast it sells (ADR-368). */
export const SALES_PACE_DAYS = 30;

/**
 * How a season's pace may differ from the usual (INV-08, ADR-863): no less than a quarter, no
 * more than eight times, and how far ahead a season is looked for.
 */
export const SEASON_LIMITS = { lift: { min: 0.25, max: 8 }, aheadDays: 90 } as const;

/** A season on or ahead, and how much faster than usual what sells sold in it last year. */
export interface SeasonOutlook {
  season: PkSeason;
  /** Units a day in last year's season over units a day in the 30 days before it; null for none. */
  lift: number | null;
  /** The lift is the shop's, all its variants together, as the variant has no such history. */
  fromShop: boolean;
}

/**
 * The season on at `at`, or the next to begin within {@link SEASON_LIMITS.aheadDays}; null for
 * none. Where one that follows the moon meets another, the moon's is the one shoppers buy for
 * (ADR-891): Ramadan in the lawn launch is Ramadan.
 */
export function seasonAhead(at: Date = new Date()): PkSeason | null {
  const today = pkDayOf(at);
  const ahead = pkSeasonsBetween(today, addDays(today, SEASON_LIMITS.aheadDays - 1));
  const on = ahead.filter((season) => season.start <= today);
  return on.find((season) => season.moon) ?? on[0] ?? ahead[0] ?? null;
}

/**
 * How much faster `seasonUnits` sold over `seasonDays` than `baseUnits` over the 30 days before:
 * within {@link SEASON_LIMITS.lift}, to two places; null where either sold none.
 */
export function liftOf(seasonUnits: number, seasonDays: number, baseUnits: number): number | null {
  if (seasonUnits <= 0 || baseUnits <= 0 || seasonDays <= 0) return null;
  const lift = seasonUnits / seasonDays / (baseUnits / SALES_PACE_DAYS);
  const { min, max } = SEASON_LIMITS.lift;
  return Math.round(Math.min(max, Math.max(min, lift)) * 100) / 100;
}

/**
 * Units a variant is expected to sell in the `days` from `today`: its pace over the last 30, and
 * on the days in `outlook`'s season, that pace times its lift; rounded up.
 */
export function forecastUnits(
  soldLast30Days: number,
  days: number,
  today: string,
  outlook: SeasonOutlook | null,
): number {
  const pace = soldLast30Days / SALES_PACE_DAYS;
  const inSeason =
    outlook && outlook.lift !== null
      ? daysInSeason(outlook.season, today, addDays(today, days - 1))
      : 0;
  return Math.ceil(pace * (days - inSeason + inSeason * (outlook?.lift ?? 1)));
}

/**
 * Whole days `available` units last when `sold` sold in the last SALES_PACE_DAYS: none when
 * there are none; null when none sold, as there is no pace to go by.
 */
export function daysLeft(available: number, sold: number): number | null {
  if (sold <= 0) return null;
  if (available <= 0) return 0;
  return Math.floor((available * SALES_PACE_DAYS) / sold);
}

/** A shop's inventory settings. */
export interface InventorySettingsRecord {
  /** A variant is low on stock with this many units for sale online, or fewer (ADR-125). */
  lowStockThreshold: number;
  /** Null while the shop has the defaults. */
  updatedAt: Date | null;
}

/** Fields left out stay as they are. */
export interface InventorySettingsInput {
  lowStockThreshold?: number | null;
}

/** A variant running low or out of stock, with what staff need to reorder it. */
export interface LowStockRecord {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  /** Units that can be sold online, as its inventoryQuantity says: none or fewer is out. */
  available: number;
  /** The location it was counted at, when listed for one (ADR-359); null for online sales. */
  locationId?: string | null;
}

/** A variant just fallen to the shop's threshold, or run out after running low (ADR-157). */
export interface LowStockAlert extends LowStockRecord {
  state: 'low' | 'out';
  threshold: number;
  /** When its spell of low stock began: one alert a spell, and one more when it runs out. */
  since: Date;
}

/** How many of the shop's variants run low, and how many are out. */
export interface LowStockCounts {
  threshold: number;
  /** Some for sale, the threshold or fewer. */
  low: number;
  /** None for sale. */
  out: number;
}

/** Where a page of the low-stock list ended: its last variant's units, and its ID. */
export interface LowStockCursor {
  available: number;
  variantId: string;
}

/** The shop's inventory settings in the caller's transaction `tx`, or the defaults. */
export async function inventorySettingsIn(
  tx: Tx,
  shopId: string,
): Promise<InventorySettingsRecord> {
  const { rows } = await tx.execute<{ low_stock_threshold: number; updated_at: string }>(sql`
    SELECT low_stock_threshold, updated_at FROM inventory.settings WHERE shop_id = ${shopId}`);
  const row = rows[0];
  return row
    ? { lowStockThreshold: row.low_stock_threshold, updatedAt: toDateOrNull(row.updated_at) }
    : { lowStockThreshold: LOW_STOCK_THRESHOLD.default, updatedAt: null };
}

/**
 * Low stock (INV-01, ADR-125): the shop's tracked variants of active products with its threshold
 * or fewer units for sale online, counted for the admin's home and listed for staff to reorder,
 * the fewest first. Worked out from the levels when asked; nothing is stored but the threshold.
 */
@Injectable()
export class LowStockService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  settings(tenant: TenantContext): Promise<InventorySettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => inventorySettingsIn(tx, tenant.shopId));
  }

  async updateSettings(
    tenant: TenantContext,
    input: InventorySettingsInput,
  ): Promise<MutationResult<InventorySettingsRecord>> {
    const check = new InputChecker();
    const threshold = input.lowStockThreshold;
    if (threshold === null) {
      check.addMessage(['input', 'lowStockThreshold'], 'BLANK', "Low stock can't be blank");
    } else if (
      threshold !== undefined &&
      (!Number.isInteger(threshold) ||
        threshold < LOW_STOCK_THRESHOLD.min ||
        threshold > LOW_STOCK_THRESHOLD.max)
    ) {
      check.addMessage(
        ['input', 'lowStockThreshold'],
        'INVALID',
        `Low stock is a whole number of units from ${LOW_STOCK_THRESHOLD.min} to ${LOW_STOCK_THRESHOLD.max.toLocaleString('en')}`,
      );
    }
    if (!check.ok || threshold === null) return { ok: false, errors: check.errors };
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const current = await inventorySettingsIn(tx, shopId);
      if (threshold === undefined || threshold === current.lowStockThreshold) {
        return { ok: true, value: current };
      }
      const { rows } = await tx.execute<{ version: number; updated_at: string }>(sql`
        INSERT INTO inventory.settings (shop_id, low_stock_threshold)
        VALUES (${shopId}, ${threshold})
        ON CONFLICT (shop_id) DO UPDATE
          SET low_stock_threshold = EXCLUDED.low_stock_threshold,
              version = inventory.settings.version + 1, updated_at = now()
        RETURNING version, updated_at`);
      await appendEvent<InventorySettingsUpdatedPayload>(tx, shopId, {
        type: InventoryEvents.InventorySettingsUpdated,
        aggregateType: 'inventory_settings',
        aggregateId: shopId,
        payload: {
          changed: ['lowStockThreshold'],
          lowStockThreshold: threshold,
          version: rows[0]!.version,
        },
      });
      return {
        ok: true,
        value: { lowStockThreshold: threshold, updatedAt: toDateOrNull(rows[0]!.updated_at) },
      };
    });
  }

  /** How many of the shop's variants run low and out, for the admin's home. */
  async counts(tenant: TenantContext): Promise<LowStockCounts> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { lowStockThreshold: threshold } = await inventorySettingsIn(tx, tenant.shopId);
      const items = await this.#lowIn(tx, tenant.shopId, threshold);
      return {
        threshold,
        low: items.filter((item) => item.available > 0).length,
        out: items.filter((item) => item.available <= 0).length,
      };
    });
  }

  /**
   * The shop's variants running low or out, the fewest for sale first, then by ID; with
   * `locationId`, those stocked at that location before, by what is available there (ADR-359).
   */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: LowStockCursor | null; locationId?: string | null },
  ): Promise<Page<LowStockRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { lowStockThreshold } = await inventorySettingsIn(tx, tenant.shopId);
      const { after } = options;
      const low = options.locationId
        ? await this.#lowAt(tx, tenant.shopId, lowStockThreshold, options.locationId)
        : await this.#lowIn(tx, tenant.shopId, lowStockThreshold);
      const items = low
        .sort((x, y) => x.available - y.available || x.variantId.localeCompare(y.variantId))
        .filter(
          (item) =>
            !after ||
            item.available > after.available ||
            (item.available === after.available && item.variantId > after.variantId),
        );
      return {
        items: items.slice(0, options.first),
        hasNextPage: items.length > options.first,
      };
    });
  }

  /**
   * What each of `variantIds` sold in the last `days` days (INV-08, ADR-368), as the ledger says:
   * units committed to orders, less commitments released when orders were cancelled or changed;
   * never below none. At `locationId` alone where given, or at all the shop's locations. Shipping
   * moves units out of committed, not into it, so it is not counted twice. A variant that sold
   * none is left out.
   */
  async soldOf(
    tenant: TenantContext,
    variantIds: readonly string[],
    locationId: string | null,
    days = SALES_PACE_DAYS,
  ): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ variant_id: string; sold: number }>(sql`
        SELECT m.variant_id, GREATEST(SUM(m.delta), 0)::int AS sold
          FROM inventory.movements m
          JOIN inventory.adjustments a ON a.shop_id = m.shop_id AND a.id = m.adjustment_id
         WHERE m.shop_id = ${tenant.shopId}
           AND m.variant_id = ANY(${sql.param([...new Set(variantIds)])}::uuid[])
           AND m.quantity_name = 'committed'
           AND a.reason IN ('committed', 'commitment_released')
           AND m.created_at >= now() - make_interval(days => ${days})
           ${locationId ? sql`AND m.location_id = ${locationId}` : sql``}
         GROUP BY m.variant_id`);
      return new Map(rows.filter((row) => row.sold > 0).map((row) => [row.variant_id, row.sold]));
    });
  }

  /**
   * How `season`'s lift was last year (ADR-863), of each of `variantIds` and of the shop: units
   * sold in last year's season and in the 30 days before it, from the ledger as {@link soldOf}
   * counts them, in Pakistan's days. Variants without both are left out; the shop's is null
   * without them, or with no season the year before.
   */
  async seasonLifts(
    tenant: TenantContext,
    variantIds: readonly string[],
    locationId: string | null,
    season: PkSeason,
  ): Promise<{ shop: number | null; variants: Map<string, number> }> {
    const last = previousPkSeason(season);
    if (!last) return { shop: null, variants: new Map() };
    const baseFrom = addDays(last.start, -SALES_PACE_DAYS);
    const seasonDays = daysInSeason(last, last.start, last.end);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        variant_id: string | null;
        in_season: number;
        before: number;
      }>(sql`
        WITH sold AS (
          SELECT m.variant_id, (m.created_at AT TIME ZONE 'Asia/Karachi')::date AS day, m.delta
            FROM inventory.movements m
            JOIN inventory.adjustments a ON a.shop_id = m.shop_id AND a.id = m.adjustment_id
           WHERE m.shop_id = ${tenant.shopId}
             AND m.quantity_name = 'committed'
             AND a.reason IN ('committed', 'commitment_released')
             AND m.created_at >= (${baseFrom}::date)::timestamp AT TIME ZONE 'Asia/Karachi'
             AND m.created_at < ((${last.end}::date) + 1)::timestamp AT TIME ZONE 'Asia/Karachi'
             ${locationId ? sql`AND m.location_id = ${locationId}` : sql``})
        SELECT CASE WHEN GROUPING(variant_id) = 1 THEN NULL ELSE variant_id END AS variant_id,
               GREATEST(SUM(delta) FILTER (WHERE day >= ${last.start}::date), 0)::int AS in_season,
               GREATEST(SUM(delta) FILTER (WHERE day < ${last.start}::date), 0)::int AS before
          FROM sold
         GROUP BY ROLLUP (variant_id)`);
      const wanted = new Set(variantIds);
      const variants = new Map<string, number>();
      let shop: number | null = null;
      for (const row of rows) {
        const lift = liftOf(row.in_season, seasonDays, row.before);
        if (row.variant_id === null) shop = lift;
        else if (lift !== null && wanted.has(row.variant_id)) variants.set(row.variant_id, lift);
      }
      return { shop, variants };
    });
  }

  /**
   * Where a variant stands after its stock changed (ADR-157): the alert to send when it falls to
   * the shop's threshold, or runs out after running low, once a spell; null otherwise. Its spell
   * of low stock is kept until it is stocked above the threshold again, or is no longer tracked or
   * for sale, when it ends. In the caller's transaction `tx`.
   */
  async alertIn(tx: Tx, shopId: string, variantId: string): Promise<LowStockAlert | null> {
    const { lowStockThreshold: threshold } = await inventorySettingsIn(tx, shopId);
    const available = await availableIn(tx, shopId, variantId);
    const snapshot =
      available === null
        ? undefined
        : (await this.variants.snapshotsOf(tx, shopId, [variantId])).get(variantId);
    if (available === null || snapshot?.productStatus !== 'active' || available > threshold) {
      await tx.execute(sql`
        DELETE FROM inventory.low_stock_spells
         WHERE shop_id = ${shopId} AND variant_id = ${variantId}`);
      return null;
    }
    const state = available <= 0 ? 'out' : 'low';
    const { rows: begun } = await tx.execute<{ created_at: string | Date }>(sql`
      INSERT INTO inventory.low_stock_spells (shop_id, variant_id, state, available)
      VALUES (${shopId}, ${variantId}, ${state}, ${available})
          ON CONFLICT DO NOTHING
      RETURNING created_at`);
    let since: Date;
    let alert: boolean;
    if (begun[0]) {
      since = toDate(begun[0].created_at);
      alert = true;
    } else {
      const { rows } = await tx.execute<{ state: 'low' | 'out'; created_at: string | Date }>(sql`
        UPDATE inventory.low_stock_spells s
           SET state = ${state}, available = ${available}, updated_at = now()
          FROM (SELECT state FROM inventory.low_stock_spells
                 WHERE shop_id = ${shopId} AND variant_id = ${variantId}
                   FOR UPDATE) before
         WHERE s.shop_id = ${shopId} AND s.variant_id = ${variantId}
        RETURNING before.state, s.created_at`);
      if (!rows[0]) return null;
      since = toDate(rows[0].created_at);
      // Low already told: told again only when it runs out.
      alert = rows[0].state === 'low' && state === 'out';
    }
    if (!alert) return null;
    return {
      variantId,
      productId: snapshot.productId,
      productTitle: snapshot.productTitle,
      variantTitle: snapshot.variantTitle,
      sku: snapshot.sku,
      available,
      state,
      threshold,
      since,
    };
  }

  /**
   * The shop's tracked variants with `threshold` or fewer units for sale online: available at its
   * active locations that fulfil online orders, as a variant's inventoryQuantity counts them, none
   * where it was never stocked. Variants of products not active are left out, told by the
   * catalog's own facade.
   */
  async #lowIn(tx: Tx, shopId: string, threshold: number): Promise<LowStockRecord[]> {
    const { rows } = await tx.execute<{ variant_id: string; available: number }>(sql`
      SELECT i.variant_id,
             coalesce(sum(l.available) FILTER (WHERE loc.fulfills_online_orders), 0)::int
               AS available
        FROM inventory.items i
        LEFT JOIN (inventory.levels l
                   JOIN inventory.locations loc
                     ON loc.shop_id = l.shop_id AND loc.id = l.location_id AND loc.is_active)
          ON l.shop_id = i.shop_id AND l.variant_id = i.variant_id
       WHERE i.shop_id = ${shopId} AND i.tracked
       GROUP BY i.variant_id
      HAVING coalesce(sum(l.available) FILTER (WHERE loc.fulfills_online_orders), 0)
               <= ${threshold}`);
    return this.#records(tx, shopId, rows, null);
  }

  /**
   * The shop's tracked variants stocked at an active `locationId` before, with `threshold` or
   * fewer units available there; none if the location is not the shop's or out of use.
   */
  async #lowAt(
    tx: Tx,
    shopId: string,
    threshold: number,
    locationId: string,
  ): Promise<LowStockRecord[]> {
    const { rows } = await tx.execute<{ variant_id: string; available: number }>(sql`
      SELECT i.variant_id, l.available
        FROM inventory.items i
        JOIN inventory.levels l
          ON l.shop_id = i.shop_id AND l.variant_id = i.variant_id AND l.location_id = ${locationId}
        JOIN inventory.locations loc
          ON loc.shop_id = l.shop_id AND loc.id = l.location_id AND loc.is_active
       WHERE i.shop_id = ${shopId} AND i.tracked AND l.available <= ${threshold}`);
    return this.#records(tx, shopId, rows, locationId);
  }

  /** The rows' variants of active products, with what staff need to reorder them. */
  async #records(
    tx: Tx,
    shopId: string,
    rows: readonly { variant_id: string; available: number }[],
    locationId: string | null,
  ): Promise<LowStockRecord[]> {
    if (rows.length === 0) return [];
    const snapshots = await this.variants.snapshotsOf(
      tx,
      shopId,
      rows.map((row) => row.variant_id),
    );
    return rows.flatMap((row) => {
      const snapshot = snapshots.get(row.variant_id);
      if (!snapshot || snapshot.productStatus !== 'active') return [];
      return [
        {
          variantId: row.variant_id,
          productId: snapshot.productId,
          productTitle: snapshot.productTitle,
          variantTitle: snapshot.variantTitle,
          sku: snapshot.sku,
          available: row.available,
          locationId,
        },
      ];
    });
  }
}

/**
 * A tracked variant's units for sale online: available at the shop's active locations that fulfil
 * online orders, none where it was never stocked; null for a variant not tracked.
 */
async function availableIn(tx: Tx, shopId: string, variantId: string): Promise<number | null> {
  // Units checkouts hold (ADR-715) are the shop's still: a hold neither begins a spell nor ends
  // one, as a drop's shoppers come and go.
  const { rows } = await tx.execute<{ available: number }>(sql`
    SELECT coalesce(sum(l.available + l.reserved) FILTER (WHERE loc.fulfills_online_orders), 0)::int
             AS available
      FROM inventory.items i
      LEFT JOIN (inventory.levels l
                 JOIN inventory.locations loc
                   ON loc.shop_id = l.shop_id AND loc.id = l.location_id AND loc.is_active)
        ON l.shop_id = i.shop_id AND l.variant_id = i.variant_id
     WHERE i.shop_id = ${shopId} AND i.variant_id = ${variantId} AND i.tracked
     GROUP BY i.variant_id`);
  return rows[0]?.available ?? null;
}

import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { VariantService } from '@hatti/catalog/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
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

  /** The shop's variants running low or out, the fewest for sale first, then by ID. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: LowStockCursor | null },
  ): Promise<Page<LowStockRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { lowStockThreshold } = await inventorySettingsIn(tx, tenant.shopId);
      const { after } = options;
      const items = (await this.#lowIn(tx, tenant.shopId, lowStockThreshold))
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
  const { rows } = await tx.execute<{ available: number }>(sql`
    SELECT coalesce(sum(l.available) FILTER (WHERE loc.fulfills_online_orders), 0)::int
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

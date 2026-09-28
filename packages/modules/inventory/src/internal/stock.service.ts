import type { Actor, TenantContext } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  levelKey,
  lockLevels,
  writeChanges,
  type LevelChange,
  type LockedLevel,
} from './level-store.js';
import type { AdjustmentGroupRecord } from './records.js';
import { LIMITS, STOCK_REASONS } from './rules.js';
import { items, type InventoryPolicyValue } from './schema.js';

/** Units of one variant at one location, e.g. an order line. */
export interface StockLine {
  variantId: string;
  locationId: string;
  quantity: number;
}

/** A line that cannot be reserved or committed: fewer units are available than it asks for. */
export interface StockShortage {
  variantId: string;
  locationId: string;
  requested: number;
  /** Available at the location now; can be negative. */
  available: number;
}

export type StockResult =
  | { ok: true; adjustment: AdjustmentGroupRecord | null }
  | { ok: false; shortages: StockShortage[] };

export interface StockOptions {
  /** What caused it, e.g. "hatti://orders/ord_…". */
  referenceDocumentUri?: string | null;
  /** Who to record; the tenant's actor unless given. */
  actor?: Actor | 'system';
}

type Operation = keyof typeof STOCK_REASONS;

/**
 * Null if `quantity` units can be sold from the level: its location is active, and it keeps
 * selling at zero or has enough available, counting `held` units already set aside for this sale.
 */
function shortfall(level: LockedLevel, quantity: number, held: number): StockShortage | null {
  const enough =
    level.locationActive &&
    (level.inventoryPolicy === 'continue' || level.available + held >= quantity);
  return enough
    ? null
    : {
        variantId: level.variantId,
        locationId: level.locationId,
        requested: quantity,
        available: level.available,
      };
}

/** A line's change of its locked level, or why it cannot happen. */
function lineChange(
  operation: Operation,
  level: LockedLevel,
  quantity: number,
  fromReservation: boolean,
): LevelChange | StockShortage {
  const none = { level, onHand: 0, committed: 0, reserved: 0, safetyStock: 0 };
  switch (operation) {
    case 'reserve':
      return shortfall(level, quantity, 0) ?? { ...none, reserved: quantity };
    case 'releaseReservation':
      return { ...none, reserved: -Math.min(quantity, level.reserved) };
    case 'commit': {
      // A checkout's hold becomes the order's, so the units it held count as available to it.
      const held = fromReservation ? Math.min(quantity, level.reserved) : 0;
      return shortfall(level, quantity, held) ?? { ...none, reserved: -held, committed: quantity };
    }
    case 'releaseCommitment':
      return { ...none, committed: -Math.min(quantity, level.committed) };
    case 'fulfill':
      // The goods have left: on hand falls by all of them, even if fewer were committed here.
      return { ...none, committed: -Math.min(quantity, level.committed), onHand: -quantity };
    case 'restock':
      return { ...none, onHand: quantity };
  }
}

function isShortage(value: LevelChange | StockShortage): value is StockShortage {
  return 'requested' in value;
}

/** Adds up lines for the same variant and location, and checks quantities. */
function mergeLines(lines: readonly StockLine[]): StockLine[] {
  const merged = new Map<string, StockLine>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > LIMITS.quantity) {
      throw new RangeError(`Stock line quantity must be a whole number from 1: ${line.quantity}`);
    }
    const key = levelKey(line.variantId, line.locationId);
    const existing = merged.get(key);
    merged.set(key, existing ? { ...line, quantity: existing.quantity + line.quantity } : line);
  }
  return [...merged.values()];
}

/**
 * Stock for checkouts and orders, run inside the caller's transaction so it commits or rolls
 * back with the order. All lines apply, or none.
 *
 * - `reserve` holds units for a checkout; `releaseReservation` lets them go.
 * - `commit` promises units to a placed order; `releaseCommitment` undoes it on cancellation.
 * - `fulfill` ships committed units: on hand and committed both fall.
 * - `restock` puts units that came back on the shelf: on hand rises.
 *
 * Reserving and committing check available stock under a row lock, so two buyers can never
 * get the same unit. They report shortages instead of failing when stock is short and the item
 * does not continue selling at zero. Untracked items, and tracked items with no stock recorded
 * at the location, change nothing, except that the second are short when they stop selling at
 * zero. Releases never take a quantity below zero.
 */
@Injectable()
export class StockService {
  reserve(tx: Tx, tenant: TenantContext, lines: readonly StockLine[], options: StockOptions = {}) {
    return this.#apply(tx, tenant, 'reserve', lines, options, false);
  }

  releaseReservation(
    tx: Tx,
    tenant: TenantContext,
    lines: readonly StockLine[],
    options: StockOptions = {},
  ) {
    return this.#apply(tx, tenant, 'releaseReservation', lines, options, false);
  }

  /** With `fromReservation`, the units a checkout reserved become the order's. */
  commit(
    tx: Tx,
    tenant: TenantContext,
    lines: readonly StockLine[],
    options: StockOptions & { fromReservation?: boolean } = {},
  ) {
    return this.#apply(tx, tenant, 'commit', lines, options, options.fromReservation ?? false);
  }

  releaseCommitment(
    tx: Tx,
    tenant: TenantContext,
    lines: readonly StockLine[],
    options: StockOptions = {},
  ) {
    return this.#apply(tx, tenant, 'releaseCommitment', lines, options, false);
  }

  fulfill(tx: Tx, tenant: TenantContext, lines: readonly StockLine[], options: StockOptions = {}) {
    return this.#apply(tx, tenant, 'fulfill', lines, options, false);
  }

  restock(tx: Tx, tenant: TenantContext, lines: readonly StockLine[], options: StockOptions = {}) {
    return this.#apply(tx, tenant, 'restock', lines, options, false);
  }

  async #apply(
    tx: Tx,
    tenant: TenantContext,
    operation: Operation,
    lines: readonly StockLine[],
    options: StockOptions,
    fromReservation: boolean,
  ): Promise<StockResult> {
    const merged = mergeLines(lines);
    const levels = await lockLevels(tx, tenant.shopId, merged);
    const missing = merged.filter((line) => !levels.has(levelKey(line.variantId, line.locationId)));
    const policies = await this.#trackedPolicies(
      tx,
      tenant.shopId,
      missing.map((line) => line.variantId),
    );

    const shortages: StockShortage[] = [];
    const changes: LevelChange[] = [];
    for (const line of merged) {
      const level = levels.get(levelKey(line.variantId, line.locationId));
      if (!level) {
        // Nothing recorded here. A tracked item that stops at zero cannot be sold from here.
        const policy = policies.get(line.variantId);
        const selling = operation === 'reserve' || (operation === 'commit' && !fromReservation);
        if (selling && policy === 'deny') {
          shortages.push({
            variantId: line.variantId,
            locationId: line.locationId,
            requested: line.quantity,
            available: 0,
          });
        }
        continue;
      }
      if (!level.tracked) continue;
      const change = lineChange(operation, level, line.quantity, fromReservation);
      if (isShortage(change)) shortages.push(change);
      else changes.push(change);
    }
    if (shortages.length > 0) return { ok: false, shortages };

    const adjustment = await writeChanges(
      tx,
      tenant.shopId,
      {
        reason: STOCK_REASONS[operation],
        referenceDocumentUri: options.referenceDocumentUri ?? null,
        actor: options.actor ?? tenant.actor,
      },
      changes,
    );
    return { ok: true, adjustment };
  }

  /** The policy of each tracked item among `variantIds`. */
  async #trackedPolicies(
    tx: Tx,
    shopId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, InventoryPolicyValue>> {
    if (variantIds.length === 0) return new Map();
    const rows = await tx
      .select({ variantId: items.variantId, policy: items.inventoryPolicy })
      .from(items)
      .where(
        and(
          eq(items.shopId, shopId),
          eq(items.tracked, true),
          inArray(items.variantId, [...new Set(variantIds)]),
        ),
      );
    return new Map(rows.map((row) => [row.variantId, row.policy]));
  }
}

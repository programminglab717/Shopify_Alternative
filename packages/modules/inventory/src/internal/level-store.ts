import type { Actor } from '@hatti/api';
import { toDate, type Tx } from '@hatti/db';
import { appendEvents } from '@hatti/events';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { InventoryEvents, type InventoryLevelUpdatedPayload } from './events.js';
import { locationFromJson, type LocationJson } from './location-store.js';
import type {
  AdjustmentGroupRecord,
  InventoryChangeRecord,
  LocationRecord,
  Quantities,
} from './records.js';
import {
  QUANTITY_NAMES,
  type ActorKind,
  type InventoryPolicyValue,
  type QuantityName,
} from './schema.js';

// How stock changes, for merchants and for orders alike:
//   1. create missing items and levels, in (variant, location) order (merchant changes only);
//   2. lock the levels, in the same order, and read them;
//   3. check the change against the locked quantities;
//   4. write the levels, the adjustment and its movements in one statement, then the events.
// Every writer locks in the same order, so concurrent writers wait for each other and never
// deadlock; nothing changes a level between its check and its write. Step 2 also takes a key-share
// lock on each location, which a deactivation's exclusive lock waits for, and the reverse.

export interface LevelKey {
  variantId: string;
  locationId: string;
}

export function levelKey(variantId: string, locationId: string): string {
  return `${variantId}/${locationId}`;
}

/** A level locked for update, with what decides how it may change. */
export interface LockedLevel extends Quantities {
  id: string;
  variantId: string;
  locationId: string;
  productId: string;
  tracked: boolean;
  inventoryPolicy: InventoryPolicyValue;
  locationActive: boolean;
  version: number;
}

interface LockedLevelRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  location_id: string;
  on_hand: number;
  committed: number;
  reserved: number;
  safety_stock: number;
  available: number;
  version: number;
  product_id: string;
  tracked: boolean;
  inventory_policy: InventoryPolicyValue;
  location_active: boolean;
}

function columns(keys: readonly LevelKey[]) {
  return {
    variantIds: keys.map((key) => key.variantId),
    locationIds: keys.map((key) => key.locationId),
  };
}

/** Locks the levels among `keys` that exist, in (variant, location) order. */
export async function lockLevels(
  tx: Tx,
  shopId: string,
  keys: readonly LevelKey[],
): Promise<Map<string, LockedLevel>> {
  if (keys.length === 0) return new Map();
  const { variantIds, locationIds } = columns(keys);
  const { rows } = await tx.execute<LockedLevelRow>(sql`
    SELECT l.id, l.variant_id, l.location_id, l.on_hand, l.committed, l.reserved,
           l.safety_stock, l.available, l.version,
           i.product_id, i.tracked, i.inventory_policy, loc.is_active AS location_active
      FROM inventory.levels l
      JOIN inventory.items i ON i.shop_id = l.shop_id AND i.variant_id = l.variant_id
      JOIN inventory.locations loc ON loc.shop_id = l.shop_id AND loc.id = l.location_id
     WHERE l.shop_id = ${shopId}
       AND (l.variant_id, l.location_id) IN (
             SELECT * FROM unnest(${sql.param(variantIds)}::uuid[], ${sql.param(locationIds)}::uuid[]))
     ORDER BY l.variant_id, l.location_id
       FOR UPDATE OF l FOR KEY SHARE OF loc`);
  return new Map(
    rows.map((row) => [
      levelKey(row.variant_id, row.location_id),
      {
        id: row.id,
        variantId: row.variant_id,
        locationId: row.location_id,
        onHand: row.on_hand,
        committed: row.committed,
        reserved: row.reserved,
        safetyStock: row.safety_stock,
        available: row.available,
        version: row.version,
        productId: row.product_id,
        tracked: row.tracked,
        inventoryPolicy: row.inventory_policy,
        locationActive: row.location_active,
      },
    ]),
  );
}

/**
 * Creates the items that do not exist yet, as tracked: recording stock starts tracking it.
 * Returns the variants whose items it created.
 */
export async function ensureItems(
  tx: Tx,
  shopId: string,
  productIdByVariant: ReadonlyMap<string, string>,
): Promise<string[]> {
  if (productIdByVariant.size === 0) return [];
  const { rows } = await tx.execute<{ variant_id: string }>(sql`
    INSERT INTO inventory.items (shop_id, variant_id, product_id, tracked)
    SELECT ${shopId}, u.variant_id, u.product_id, true
      FROM unnest(${sql.param([...productIdByVariant.keys()])}::uuid[],
                  ${sql.param([...productIdByVariant.values()])}::uuid[]) AS u(variant_id, product_id)
     ORDER BY u.variant_id
        ON CONFLICT DO NOTHING
    RETURNING variant_id`);
  return rows.map((row) => row.variant_id);
}

/** Creates the levels among `keys` that do not exist yet, with zero quantities. */
export async function ensureLevels(
  tx: Tx,
  shopId: string,
  keys: readonly LevelKey[],
): Promise<void> {
  if (keys.length === 0) return;
  const { variantIds, locationIds } = columns(keys);
  await tx.execute(sql`
    INSERT INTO inventory.levels (shop_id, variant_id, location_id)
    SELECT ${shopId}, u.variant_id, u.location_id
      FROM unnest(${sql.param(variantIds)}::uuid[], ${sql.param(locationIds)}::uuid[])
           AS u(variant_id, location_id)
     ORDER BY u.variant_id, u.location_id
        ON CONFLICT DO NOTHING`);
}

/** Amounts to add to a locked level's quantities. */
export interface LevelChange {
  level: LockedLevel;
  onHand: number;
  committed: number;
  reserved: number;
  safetyStock: number;
}

export interface AdjustmentMeta {
  reason: string;
  referenceDocumentUri: string | null;
  actor: Actor | 'system';
}

function actorColumns(actor: Actor | 'system'): { kind: ActorKind; id: string | null } {
  if (actor === 'system') return { kind: 'system', id: null };
  return actor.kind === 'app'
    ? { kind: 'app', id: actor.tokenId }
    : { kind: 'staff', id: actor.userId };
}

interface WrittenRow extends Record<string, unknown> {
  movement_id: string;
  quantity_name: QuantityName;
  delta: number;
  quantity_after: number;
  available_after: number;
  level_id: string;
  variant_id: string;
  location_id: string;
  on_hand: number;
  committed: number;
  reserved: number;
  safety_stock: number;
  available: number;
  version: number;
  adjusted_at: string;
  location: LocationJson;
}

/**
 * Applies changes to levels locked by {@link lockLevels}: one statement updates them and records
 * the adjustment and a movement per quantity changed, then one more records an
 * `inventory_level.updated` per level. Changes that add nothing are left out; if none remain,
 * nothing is written and the result is null.
 */
export async function writeChanges(
  tx: Tx,
  shopId: string,
  meta: AdjustmentMeta,
  changes: readonly LevelChange[],
): Promise<AdjustmentGroupRecord | null> {
  const effective = changes.filter(
    (change) =>
      change.onHand !== 0 ||
      change.committed !== 0 ||
      change.reserved !== 0 ||
      change.safetyStock !== 0,
  );
  if (effective.length === 0) return null;
  const adjustmentId = newId();
  const actor = actorColumns(meta.actor);
  // One movement per quantity changed. IDs come from here, not the database, because they order
  // history and only these are monotonic within a millisecond.
  const moves = effective.flatMap((change) =>
    (
      [
        ['on_hand', change.onHand],
        ['committed', change.committed],
        ['reserved', change.reserved],
        ['safety_stock', change.safetyStock],
      ] as const
    )
      .filter(([, delta]) => delta !== 0)
      .map(([name, delta]) => ({ id: newId(), change, name, delta })),
  );
  const { rows } = await tx.execute<WrittenRow>(sql`
    WITH d AS (
      SELECT *
        FROM unnest(${sql.param(effective.map((change) => change.level.variantId))}::uuid[],
                    ${sql.param(effective.map((change) => change.level.locationId))}::uuid[],
                    ${sql.param(effective.map((change) => change.onHand))}::int[],
                    ${sql.param(effective.map((change) => change.committed))}::int[],
                    ${sql.param(effective.map((change) => change.reserved))}::int[],
                    ${sql.param(effective.map((change) => change.safetyStock))}::int[])
             AS d(variant_id, location_id, on_hand, committed, reserved, safety_stock)
    ),
    g AS (
      INSERT INTO inventory.adjustments
             (shop_id, id, reason, reference_document_uri, actor_kind, actor_id)
      VALUES (${shopId}, ${adjustmentId}, ${meta.reason}, ${meta.referenceDocumentUri},
              ${actor.kind}, ${actor.id})
      RETURNING created_at
    ),
    u AS (
      UPDATE inventory.levels l
         SET on_hand = l.on_hand + d.on_hand,
             committed = l.committed + d.committed,
             reserved = l.reserved + d.reserved,
             safety_stock = l.safety_stock + d.safety_stock,
             version = l.version + 1,
             updated_at = now()
        FROM d
       WHERE l.shop_id = ${shopId} AND l.variant_id = d.variant_id
         AND l.location_id = d.location_id
      RETURNING l.id, l.variant_id, l.location_id, l.on_hand, l.committed, l.reserved,
                l.safety_stock, l.available, l.version
    ),
    mv AS (
      SELECT *
        FROM unnest(${sql.param(moves.map((move) => move.id))}::uuid[],
                    ${sql.param(moves.map((move) => move.change.level.variantId))}::uuid[],
                    ${sql.param(moves.map((move) => move.change.level.locationId))}::uuid[],
                    ${sql.param(moves.map((move) => move.name))}::text[],
                    ${sql.param(moves.map((move) => move.delta))}::int[])
             AS mv(id, variant_id, location_id, quantity_name, delta)
    ),
    m AS (
      INSERT INTO inventory.movements
             (shop_id, id, adjustment_id, variant_id, location_id, quantity_name, delta,
              quantity_after, available_after)
      SELECT ${shopId}, mv.id, ${adjustmentId}, mv.variant_id, mv.location_id, mv.quantity_name,
             mv.delta,
             CASE mv.quantity_name WHEN 'on_hand' THEN u.on_hand
                                   WHEN 'committed' THEN u.committed
                                   WHEN 'reserved' THEN u.reserved
                                   ELSE u.safety_stock END,
             u.available
        FROM mv
        JOIN u ON u.variant_id = mv.variant_id AND u.location_id = mv.location_id
      RETURNING id, variant_id, location_id, quantity_name, delta, quantity_after, available_after
    )
    SELECT m.id AS movement_id, m.quantity_name, m.delta, m.quantity_after, m.available_after,
           u.id AS level_id, u.variant_id, u.location_id, u.on_hand, u.committed, u.reserved,
           u.safety_stock, u.available, u.version, g.created_at AS adjusted_at,
           to_jsonb(loc) AS location
      FROM m
      JOIN u ON u.variant_id = m.variant_id AND u.location_id = m.location_id
     CROSS JOIN g
      JOIN inventory.locations loc ON loc.shop_id = ${shopId} AND loc.id = u.location_id
     ORDER BY u.variant_id, u.location_id,
              array_position(${sql.param(QUANTITY_NAMES)}::text[], m.quantity_name)`);

  const productIds = new Map(
    effective.map((change) => [change.level.variantId, change.level.productId]),
  );
  const locationsById = new Map<string, LocationRecord>();
  const levels = new Map<string, WrittenRow>();
  const changeRecords = rows.map((row): InventoryChangeRecord => {
    let location = locationsById.get(row.location_id);
    if (!location) {
      location = locationFromJson(row.location);
      locationsById.set(row.location_id, location);
    }
    levels.set(row.level_id, row);
    return {
      id: row.movement_id,
      adjustmentId,
      variantId: row.variant_id,
      location,
      name: row.quantity_name,
      delta: row.delta,
      quantityAfter: row.quantity_after,
      availableAfter: row.available_after,
      reason: meta.reason,
      referenceDocumentUri: meta.referenceDocumentUri,
      createdAt: toDate(row.adjusted_at),
    };
  });
  if (levels.size !== effective.length) {
    throw new Error(`Expected to update ${effective.length} locked levels, updated ${levels.size}`);
  }

  await appendEvents<InventoryLevelUpdatedPayload>(
    tx,
    shopId,
    [...levels.values()].map((row) => ({
      type: InventoryEvents.InventoryLevelUpdated,
      aggregateType: 'inventory_level',
      aggregateId: row.level_id,
      payload: {
        inventoryItemId: row.variant_id,
        productId: productIds.get(row.variant_id)!,
        locationId: row.location_id,
        onHand: row.on_hand,
        committed: row.committed,
        reserved: row.reserved,
        safetyStock: row.safety_stock,
        available: row.available,
        reason: meta.reason,
        adjustmentId,
        version: row.version,
      },
    })),
  );

  return {
    id: adjustmentId,
    reason: meta.reason,
    referenceDocumentUri: meta.referenceDocumentUri,
    createdAt: toDate(rows[0]!.adjusted_at),
    changes: changeRecords,
  };
}

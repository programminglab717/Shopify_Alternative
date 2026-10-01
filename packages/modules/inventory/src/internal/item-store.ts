import { executePrepared, toDate, type Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { locationFromJson, type LocationJson } from './location-store.js';
import type { InventoryItemRecord } from './records.js';
import type { InventoryPolicyValue } from './schema.js';

/** The item of a variant whose stock was never recorded: not tracked, stocked nowhere. */
export function untrackedItem(variantId: string): InventoryItemRecord {
  return { variantId, tracked: false, inventoryPolicy: 'deny', levels: [] };
}

/** Units that can be sold online: available at active locations that fulfil online orders. */
export function sellableQuantity(item: InventoryItemRecord): number {
  return item.levels
    .filter((level) => level.location.fulfillsOnlineOrders)
    .reduce((sum, level) => sum + level.available, 0);
}

/** Whether stock allows selling the variant online. */
export function availableForSale(item: InventoryItemRecord): boolean {
  return !item.tracked || item.inventoryPolicy === 'continue' || sellableQuantity(item) > 0;
}

interface ItemLevelRow extends Record<string, unknown> {
  variant_id: string;
  tracked: boolean;
  inventory_policy: InventoryPolicyValue;
  level_id: string | null;
  on_hand: number;
  committed: number;
  reserved: number;
  safety_stock: number;
  available: number;
  level_updated_at: string;
  location: LocationJson;
}

/**
 * The items of those of `variantIds` whose stock was ever recorded, with their levels at active
 * locations: primary first, then by name. One query, however many variants.
 */
export async function loadItems(
  tx: Tx,
  shopId: string,
  variantIds: readonly string[],
): Promise<Map<string, InventoryItemRecord>> {
  const items = new Map<string, InventoryItemRecord>();
  if (variantIds.length === 0) return items;
  // Prepared (ADR-111): every cart read asks what its items can still sell.
  const { rows } = await executePrepared<ItemLevelRow>(
    tx,
    sql`
    SELECT i.variant_id, i.tracked, i.inventory_policy,
           l.id AS level_id, l.on_hand, l.committed, l.reserved, l.safety_stock, l.available,
           l.updated_at AS level_updated_at, to_jsonb(loc) AS location
      FROM inventory.items i
      LEFT JOIN (inventory.levels l
                 JOIN inventory.locations loc
                   ON loc.shop_id = l.shop_id AND loc.id = l.location_id AND loc.is_active)
        ON l.shop_id = i.shop_id AND l.variant_id = i.variant_id
     WHERE i.shop_id = ${shopId}
       AND i.variant_id = ANY(${sql.param([...new Set(variantIds)])}::uuid[])
     ORDER BY i.variant_id, loc.is_primary DESC, lower(loc.name), loc.id`,
  );
  for (const row of rows) {
    let item = items.get(row.variant_id);
    if (!item) {
      item = {
        variantId: row.variant_id,
        tracked: row.tracked,
        inventoryPolicy: row.inventory_policy,
        levels: [],
      };
      items.set(row.variant_id, item);
    }
    if (row.level_id === null) continue;
    item.levels.push({
      id: row.level_id,
      variantId: row.variant_id,
      location: locationFromJson(row.location),
      onHand: row.on_hand,
      committed: row.committed,
      reserved: row.reserved,
      safetyStock: row.safety_stock,
      available: row.available,
      updatedAt: toDate(row.level_updated_at),
    });
  }
  return items;
}

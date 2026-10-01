import type { InventoryPolicyValue } from './schema.js';

/**
 * Events the inventory module publishes. Payloads are thin: fetch current state through the API.
 *
 * Every change of a level's quantities is an `inventory_level.updated` with the quantities after
 * it, whatever caused it: a stock count, a delivery, or an order. An item's settings changing,
 * including tracking starting with its first stock, is an `inventory_item.updated`.
 */
export const InventoryEvents = {
  LocationCreated: 'location.created',
  LocationUpdated: 'location.updated',
  LocationDeleted: 'location.deleted',
  InventoryItemUpdated: 'inventory_item.updated',
  InventoryLevelUpdated: 'inventory_level.updated',
  InventorySettingsUpdated: 'inventory_settings.updated',
} as const;

export interface LocationCreatedPayload {
  name: string;
  isPrimary: boolean;
}

export interface LocationUpdatedPayload {
  /** Names of what changed: fields, or "isActive". */
  changed: string[];
  version: number;
}

export interface LocationDeletedPayload {
  name: string;
}

/** The aggregate is the variant: an item is the stock side of one variant. */
export interface InventoryItemUpdatedPayload {
  productId: string;
  changed: ('tracked' | 'inventoryPolicy')[];
  tracked: boolean;
  inventoryPolicy: InventoryPolicyValue;
  version: number;
}

/** The aggregate is the level: one item at one location. */
export interface InventoryLevelUpdatedPayload {
  /** The variant. */
  inventoryItemId: string;
  productId: string;
  locationId: string;
  onHand: number;
  committed: number;
  reserved: number;
  safetyStock: number;
  available: number;
  /** Why it changed, e.g. "received" or "committed". */
  reason: string;
  adjustmentId: string;
  version: number;
}

/** The aggregate is the shop: its inventory settings, such as what it calls low stock. */
export interface InventorySettingsUpdatedPayload {
  /** "lowStockThreshold". */
  changed: string[];
  lowStockThreshold: number;
  version: number;
}

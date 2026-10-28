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
  SupplierCreated: 'supplier.created',
  SupplierUpdated: 'supplier.updated',
  PurchaseOrderCreated: 'purchase_order.created',
  PurchaseOrderUpdated: 'purchase_order.updated',
  PurchaseOrderReceived: 'purchase_order.received',
  PurchaseOrderClosed: 'purchase_order.closed',
  InventoryTransferCreated: 'inventory_transfer.created',
  InventoryTransferReceived: 'inventory_transfer.received',
  InventoryTransferCancelled: 'inventory_transfer.cancelled',
  InventoryTransferClosed: 'inventory_transfer.closed',
  /** A product put on pre-order, its day changed, or taken off (ADR-403). */
  ProductPreorderUpdated: 'product_preorder.updated',
} as const;

/** The aggregate is the product. */
export interface ProductPreorderUpdatedPayload {
  productId: string;
  /** The day it ships by now, YYYY-MM-DD; null once it is off pre-order. */
  shipsOn: string | null;
  before: string | null;
}

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
  changed: (
    | 'tracked'
    | 'inventoryPolicy'
    | 'harmonizedSystemCode'
    | 'fbrUnit'
    | 'sroScheduleNo'
    | 'sroItemSerialNo'
  )[];
  tracked: boolean;
  inventoryPolicy: InventoryPolicyValue;
  /** Its HS code now (ADR-557), null for none; left out where stock recorded started tracking it. */
  harmonizedSystemCode?: string | null;
  /** FBR's unit and SRO now (ADR-895), where changed. */
  fbrUnit?: string | null;
  sroScheduleNo?: string | null;
  sroItemSerialNo?: string | null;
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

/** The aggregate is the supplier (ADR-367). */
export interface SupplierPayload {
  name: string;
}

/**
 * The aggregate is the purchase order (ADR-367): created, changed, goods received on it, or
 * closed with what came. Each receipt's stock is its levels' `inventory_level.updated` too.
 */
export interface PurchaseOrderPayload {
  /** PO-1 onwards. */
  number: number;
  status: 'open' | 'received' | 'closed';
  supplierId: string;
  locationId: string;
  /** Units received in this change; 0 where none were. */
  received: number;
}

/**
 * The aggregate is the transfer (ADR-367): sent, received in part or in full, cancelled back, or
 * closed with the rest lost on the way.
 */
export interface InventoryTransferPayload {
  /** T-1 onwards. */
  number: number;
  status: 'in_transit' | 'received' | 'cancelled' | 'closed';
  originId: string;
  destinationId: string;
  /** Units received in this change; 0 where none were. */
  received: number;
}

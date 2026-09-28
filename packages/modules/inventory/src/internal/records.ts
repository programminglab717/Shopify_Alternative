import type { PkProvinceCode } from '@hatti/pk';
import type { InventoryPolicyValue, QuantityName } from './schema.js';

export interface LocationAddressRecord {
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: PkProvinceCode | null;
  /** Five-digit postcode. */
  zip: string | null;
  /** Mobile number in E.164 form, e.g. +923001234567. */
  phone: string | null;
}

export interface LocationRecord {
  id: string;
  name: string;
  address: LocationAddressRecord;
  isPrimary: boolean;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  deactivatedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Quantities {
  onHand: number;
  committed: number;
  reserved: number;
  safetyStock: number;
  /** onHand − committed − reserved − safetyStock. */
  available: number;
}

export interface InventoryLevelRecord extends Quantities {
  id: string;
  variantId: string;
  location: LocationRecord;
  updatedAt: Date;
}

/**
 * How a variant's stock is counted, and where it is. Every variant has one: a variant whose
 * stock was never recorded reads as not tracked, with no levels.
 */
export interface InventoryItemRecord {
  /** The variant's id; an item is the stock side of one variant. */
  variantId: string;
  tracked: boolean;
  inventoryPolicy: InventoryPolicyValue;
  /** Levels at active locations, primary first, then by name. */
  levels: InventoryLevelRecord[];
}

/** One quantity changed by an adjustment. */
export interface InventoryChangeRecord {
  /** The movement in the ledger; orders history. */
  id: string;
  adjustmentId: string;
  variantId: string;
  location: LocationRecord;
  name: QuantityName;
  delta: number;
  quantityAfter: number;
  /** The level's available quantity after the adjustment. */
  availableAfter: number;
  reason: string;
  referenceDocumentUri: string | null;
  createdAt: Date;
}

/** One change of stock and why, with the quantities it changed. */
export interface AdjustmentGroupRecord {
  id: string;
  reason: string;
  referenceDocumentUri: string | null;
  createdAt: Date;
  changes: InventoryChangeRecord[];
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}

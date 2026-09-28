export const LIMITS = {
  /** Locations per shop, active or not. */
  locations: 50,
  /** Changes or quantities per request, as in Shopify. */
  changes: 250,
  /** Largest size of any quantity; the database enforces it too. */
  quantity: 100_000_000,
  name: 255,
  addressLine: 255,
  uri: 2_048,
} as const;

/** The name of the location created when a shop first needs one. */
export const FIRST_LOCATION_NAME = 'Main location';

/**
 * Quantities that merchants and apps adjust or set. Changing "available" changes on hand by the
 * same amount; committed and reserved follow orders and checkouts only.
 */
export const SETTABLE_NAMES = ['available', 'on_hand', 'safety_stock'] as const;
export type SettableName = (typeof SETTABLE_NAMES)[number];

/** Why a merchant or an app changed stock, named as in Shopify's inventory mutations. */
export const ADJUSTMENT_REASONS = [
  /** Fixing a mistake. */
  'correction',
  /** A stock count. */
  'cycle_count_available',
  'damaged',
  'other',
  /** Given away. */
  'promotion',
  'quality_control',
  /** A delivery arrived. */
  'received',
  /** Returned goods put back on the shelf. */
  'restock',
  'safety_stock',
  /** Lost or stolen. */
  'shrinkage',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Reasons that checkouts and orders record through StockService. */
export const STOCK_REASONS = {
  reserve: 'reserved',
  releaseReservation: 'reservation_released',
  commit: 'committed',
  releaseCommitment: 'commitment_released',
  fulfill: 'fulfilled',
  /** Returned goods back on the shelf, the same reason as a merchant's restock. */
  restock: 'restock',
} as const;

/** A URI with a scheme, e.g. "hatti://orders/ord_…" or "https://erp.example.com/grn/42". */
export function isDocumentUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\S+$/i.test(value);
}

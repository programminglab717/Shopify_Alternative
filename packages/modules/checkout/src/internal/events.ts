/**
 * Events the checkout module publishes. Payloads are thin: fetch current state through the API.
 * The storefront follows what the shop charges for delivery, to show it on its pages.
 */
export const CheckoutEvents = {
  DeliverySettingsUpdated: 'delivery_settings.updated',
  CodSettingsUpdated: 'cod_settings.updated',
  TrustBadgesUpdated: 'trust_badges.updated',
} as const;

/** The shop changed what it charges for delivery. */
export interface DeliverySettingsUpdatedPayload {
  /** What changed: "charge", "freeAbove" or "zones". */
  changed: string[];
}

/** The shop changed its rules for cash on delivery at checkout. */
export interface CodSettingsUpdatedPayload {
  /**
   * What changed: "maxOrderTotal", "unavailableCities", "unavailableProductTags",
   * "refusedDeliveriesLimit", "fee" or "advance".
   */
  changed: string[];
}

/** The shop changed the badges its checkout's page shows (ADR-086). */
export interface TrustBadgesUpdatedPayload {
  /** The badges now, in order: "exchange", "original". */
  badges: string[];
}

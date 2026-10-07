/**
 * Events the checkout module publishes. Payloads are thin: fetch current state through the API.
 * The storefront follows what the shop charges for delivery, to show it on its pages.
 */
export const CheckoutEvents = {
  DeliverySettingsUpdated: 'delivery_settings.updated',
  CodSettingsUpdated: 'cod_settings.updated',
  TrustBadgesUpdated: 'trust_badges.updated',
  MarketingOptionsUpdated: 'marketing_options.updated',
  PaymentLinkCreated: 'payment_link.created',
  PaymentLinkUpdated: 'payment_link.updated',
} as const;

/** The shop changed what it charges for delivery. */
export interface DeliverySettingsUpdatedPayload {
  /** What changed: "charge", "freeAbove", "days" or "zones". */
  changed: string[];
}

/** The shop changed its rules for cash on delivery at checkout. */
export interface CodSettingsUpdatedPayload {
  /**
   * What changed: "maxOrderTotal", "unavailableCities", "unavailableProductTags",
   * "refusedDeliveriesLimit", "riskScoreLimit", "fee" or "advance".
   */
  changed: string[];
}

/** The shop changed the badges its checkout's page shows (ADR-086). */
export interface TrustBadgesUpdatedPayload {
  /** The badges now, in order: "exchange", "original". */
  badges: string[];
}

/** The shop changed the channels its checkout offers boxes for its news and offers on (ADR-187). */
export interface MarketingOptionsUpdatedPayload {
  /** The channels now, in the page's order: "whatsapp", "email". */
  channels: string[];
}

/** Staff made a payment link (ADR-248), or changed one. */
export interface PaymentLinkChangedPayload {
  /**
   * What changed: "title", "items", "discountCode", "prepaidOnly", "usageLimit", "expiresAt" or
   * "active"; none for a new link.
   */
  changed: string[];
}

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
  RecoverySettingsUpdated: 'recovery_settings.updated',
  GiftOptionsUpdated: 'gift_options.updated',
  StockHoldUpdated: 'stock_hold.updated',
} as const;

/** The shop changed what it charges for delivery. */
export interface DeliverySettingsUpdatedPayload {
  /** What changed: "charge", "freeAbove", "days", "zones", "cutoffHour" or "weights". */
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

/** The shop changed whether, and how long after they leave, it reminds shoppers (ADR-393). */
export interface RecoverySettingsUpdatedPayload {
  /** 30, 60, 180 or 600; null for never. */
  reminderAfterMinutes: number | null;
  /** The discount code offered after the reminder, and how many hours after (ADR-426). */
  offerCode: string | null;
  offerAfterHours: number | null;
}

/** The shop changed the gift options its checkout offers (CHK-16, ADR-413). */
export interface GiftOptionsUpdatedPayload {
  /** The variant sold as gift wrap; null for none. */
  wrapVariantId: string | null;
  messages: boolean;
}

/** The shop changed how long its checkouts hold their carts' stock (ADR-715). */
export interface StockHoldUpdatedPayload {
  /** Null for no holds. */
  minutes: number | null;
}

/** Staff made a payment link (ADR-248), or changed one. */
export interface PaymentLinkChangedPayload {
  /**
   * What changed: "title", "items", "discountCode", "prepaidOnly", "usageLimit", "expiresAt" or
   * "active"; none for a new link.
   */
  changed: string[];
}

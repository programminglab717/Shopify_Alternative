/**
 * Events the checkout module publishes. Payloads are thin: fetch current state through the API.
 * The storefront follows what the shop charges for delivery, to show it on its pages.
 */
export const CheckoutEvents = {
  DeliverySettingsUpdated: 'delivery_settings.updated',
} as const;

/** The shop changed what it charges for delivery. */
export interface DeliverySettingsUpdatedPayload {
  /** What changed: "charge", "freeAbove" or "zones". */
  changed: string[];
}

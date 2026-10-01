/**
 * Events the tax module publishes. Payloads are thin: fetch current state through the API.
 */
export const TaxEvents = {
  SettingsUpdated: 'tax_settings.updated',
} as const;

/** The shop changed the sales tax it charges, for orders placed from now on. */
export interface TaxSettingsUpdatedPayload {
  /** What changed: "rate" or "taxDelivery". */
  changed: string[];
}

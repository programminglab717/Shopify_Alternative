/**
 * Events the tax module publishes. Payloads are thin: fetch current state through the API.
 */
export const TaxEvents = {
  SettingsUpdated: 'tax_settings.updated',
  FbrPosUpdated: 'fbr_pos.updated',
  FbrPosDeleted: 'fbr_pos.deleted',
} as const;

/** The shop changed the sales tax it charges, for orders placed from now on. */
export interface TaxSettingsUpdatedPayload {
  /** What changed: "rate", "taxDelivery" or "categories". */
  changed: string[];
}

/** The shop connected its POS to FBR, or changed what it gave (ADR-555). */
export interface FbrPosUpdatedPayload {
  /** What changed: "posId", "accessToken", "environment" or "pctCode". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected its POS from FBR: its invoices are not reported from now on. */
export interface FbrPosDeletedPayload {
  posId: number;
  actorKind: 'app' | 'staff';
  actorId: string;
}

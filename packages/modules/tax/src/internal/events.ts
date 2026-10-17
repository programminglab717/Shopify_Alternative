import type { FbrSystem } from './fbr.js';

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

/** The shop connected to FBR, or changed what it gave (ADR-555, ADR-562). */
export interface FbrPosUpdatedPayload {
  /** How it reports now: from its POS to FBR's IMS, or through digital invoicing. */
  system: FbrSystem;
  /** What changed: "system", "posId", "accessToken", "environment" or "pctCode". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** The shop disconnected from FBR: its invoices are not reported from now on. */
export interface FbrPosDeletedPayload {
  /** How it reported. */
  system: FbrSystem;
  /** Its POS's ID; null for digital invoicing. */
  posId: number | null;
  actorKind: 'app' | 'staff';
  actorId: string;
}

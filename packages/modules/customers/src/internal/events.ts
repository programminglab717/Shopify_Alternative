import type { BlockReasonValue } from './schema.js';

/**
 * Events the customers module publishes. Payloads are thin: fetch current state through the API.
 * Blocklist events carry the number, since an entry is gone once removed.
 */
export const CustomerEvents = {
  CustomerCreated: 'customer.created',
  CustomerUpdated: 'customer.updated',
  BlocklistEntryCreated: 'blocklist_entry.created',
  BlocklistEntryUpdated: 'blocklist_entry.updated',
  BlocklistEntryDeleted: 'blocklist_entry.deleted',
} as const;

export interface CustomerCreatedPayload {
  /** From a customer's first order, or added by staff (manual) or an app (api). */
  source: 'order' | 'manual' | 'api';
  version: number;
}

export interface CustomerUpdatedPayload {
  /** Names of the fields that changed. */
  changed: string[];
  version: number;
}

export interface BlocklistEntryCreatedPayload {
  phone: string;
  reason: BlockReasonValue;
  version: number;
}

export interface BlocklistEntryUpdatedPayload {
  phone: string;
  reason: BlockReasonValue;
  /** "reason", "note" or both. */
  changed: string[];
  version: number;
}

export interface BlocklistEntryDeletedPayload {
  phone: string;
}

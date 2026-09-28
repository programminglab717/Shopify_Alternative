import type {
  BlockReasonValue,
  ConsentSourceValue,
  MarketingChannelValue,
  MarketingStateValue,
} from './schema.js';

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
  MarketingConsentUpdated: 'customer.marketing_consent_updated',
  SegmentCreated: 'segment.created',
  SegmentUpdated: 'segment.updated',
  SegmentDeleted: 'segment.deleted',
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

/** One per channel whose consent changed. */
export interface MarketingConsentUpdatedPayload {
  channel: MarketingChannelValue;
  state: MarketingStateValue;
  source: ConsentSourceValue;
  /** The customer's version after the change. */
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

export interface SegmentCreatedPayload {
  version: number;
}

export interface SegmentUpdatedPayload {
  /** "name", "query" or both. */
  changed: string[];
  version: number;
}

export type SegmentDeletedPayload = Record<string, never>;

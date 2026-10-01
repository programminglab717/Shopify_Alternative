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
  CustomerMerged: 'customer.merged',
  CustomerErased: 'customer.erased',
  CustomerErasureRequested: 'customer.erasure_requested',
  CustomerErasureCancelled: 'customer.erasure_cancelled',
  BlocklistEntryCreated: 'blocklist_entry.created',
  BlocklistEntryUpdated: 'blocklist_entry.updated',
  BlocklistEntryDeleted: 'blocklist_entry.deleted',
  MarketingConsentUpdated: 'customer.marketing_consent_updated',
  CustomerImportCreated: 'customer_import.created',
  CustomerExportCreated: 'customer_export.created',
  SegmentCreated: 'segment.created',
  SegmentUpdated: 'segment.updated',
  SegmentDeleted: 'segment.deleted',
} as const;

export interface CustomerCreatedPayload {
  /** From a customer's first order, added by staff (manual) or an app (api), or imported. */
  source: 'order' | 'manual' | 'api' | 'import';
  version: number;
}

export interface CustomerUpdatedPayload {
  /** Names of the fields that changed. */
  changed: string[];
  version: number;
}

/**
 * A duplicate was merged into the customer: its numbers, orders, tags, note and consent history
 * are the customer's now, and it is gone.
 */
export interface CustomerMergedPayload {
  mergedCustomerId: string;
  version: number;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/**
 * A customer's personal data was erased at their request; the customer is gone. The actor asked
 * for it: at once, or ahead of time, when `requestedAt` says when (ADR-110).
 */
export interface CustomerErasedPayload {
  actorKind: 'app' | 'staff';
  actorId: string;
  requestedAt?: string;
}

/** A customer's erasure was asked for, to happen at `dueAt` unless cancelled first (ADR-110). */
export interface CustomerErasureRequestedPayload {
  dueAt: string;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** A customer's erasure that was waiting to happen was cancelled. */
export interface CustomerErasureCancelledPayload {
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** One per channel whose consent changed. */
export interface MarketingConsentUpdatedPayload {
  channel: MarketingChannelValue;
  state: MarketingStateValue;
  source: ConsentSourceValue;
  /** The customer's version after the change. */
  version: number;
}

/** An import: what it did and who ran it. Each customer it touched has its own events. */
export interface CustomerImportCreatedPayload {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  rowErrors: number;
  actorKind: 'app' | 'staff';
  actorId: string;
}

/** An export of customers' data: how many, which ones, and who took it. */
export interface CustomerExportCreatedPayload {
  rows: number;
  /** The segment query it used, if not a saved segment. */
  query: string | null;
  segmentId: string | null;
  actorKind: 'app' | 'staff';
  actorId: string;
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

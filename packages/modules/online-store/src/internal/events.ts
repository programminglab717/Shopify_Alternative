import type { ThemeRoleValue } from './schema.js';

/**
 * Events the online store publishes. Payloads are thin: fetch current state through the API. The
 * storefront follows the main theme: its files changing, or another theme taking its place.
 */
export const OnlineStoreEvents = {
  ThemeCreated: 'theme.created',
  ThemeUpdated: 'theme.updated',
  ThemePublished: 'theme.published',
  ThemeDeleted: 'theme.deleted',
} as const;

export interface ThemeCreatedPayload {
  name: string;
  base: string;
}

export interface ThemeUpdatedPayload {
  /** The files saved or deleted, by filename, or "name". */
  changed: string[];
  role: ThemeRoleValue;
  version: number;
}

/** A theme became the main one. */
export interface ThemePublishedPayload {
  /** The theme that was main until then, now unpublished; null if there was none. */
  previousId: string | null;
  version: number;
}

export interface ThemeDeletedPayload {
  name: string;
}

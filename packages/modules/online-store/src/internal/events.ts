import type { ThemeRoleValue } from './schema.js';

/**
 * Events the online store publishes. Payloads are thin: fetch current state through the API. The
 * storefront follows the main theme, its files changing or another theme taking its place, the
 * menus and the pages.
 */
export const OnlineStoreEvents = {
  ThemeCreated: 'theme.created',
  ThemeUpdated: 'theme.updated',
  ThemePublished: 'theme.published',
  ThemeDeleted: 'theme.deleted',
  MenuCreated: 'menu.created',
  MenuUpdated: 'menu.updated',
  MenuDeleted: 'menu.deleted',
  PageCreated: 'page.created',
  PageUpdated: 'page.updated',
  PageDeleted: 'page.deleted',
  PreferencesUpdated: 'online_store_preferences.updated',
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

/** A menu made, changed or deleted: the storefront publishes the shop's menus again. */
export interface MenuChangedPayload {
  handle: string;
}

/** A page made or deleted. */
export interface PageChangedPayload {
  handle: string;
  isPublished: boolean;
}

/** A page changed: the storefront shows it again, and menus follow a new handle. */
export interface PageUpdatedPayload extends PageChangedPayload {
  /** The fields that changed: "title", "handle", "body", "isPublished" or "templateSuffix". */
  changed: string[];
}

/** The shop changed what it sets for its storefront as a whole. */
export interface PreferencesUpdatedPayload {
  /** The preferences that changed, such as "whatsappNumber". */
  changed: string[];
}

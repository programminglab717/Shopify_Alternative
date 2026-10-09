// Theme previews, as storefronts ask the core for them (ADR-049): a link the core signs shows a
// theme of the shop's, published or not, and the storefront hands its token back for the
// theme's files as they are saved now.

import { STOREFRONT_API_PREFIX } from './cart.js';

/** Carries a preview link's token, which names the theme and when the link ends. */
export const THEME_PREVIEW_HEADER = 'x-hatti-preview';

/** GET, with the token in {@link THEME_PREVIEW_HEADER}: the theme it shows; 404 once it shows none. */
export function themePreviewPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/theme-preview`;
}

/** A previewed theme, as saved when asked for, and when the link to it ends. */
export interface ThemePreviewResponse {
  theme: {
    id: string;
    name: string;
    /** Goes up with every change, as a main theme's does. */
    version: number;
    /** The platform theme, such as hatti-base. */
    base: string;
    /** The shop's own files, by filename, such as templates/index.json. */
    files: Record<string, string>;
  };
  expiresAt: string;
}

/**
 * GET: a picture of the shop's that one of its themes shows (ADR-326), its bytes and type; with
 * `preview`, for a page in a preview, any of its pictures, so a choice not yet saved shows. 404
 * when there is none to show.
 */
export function themeImagePath(shopId: string, fileId: string, preview: boolean): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/theme-images/${fileId}${preview ? '?preview=1' : ''}`;
}

/** A picture of a shop's, as the core sends it to the shop's storefront. */
export interface ThemeImage {
  body: Uint8Array;
  contentType: string;
}

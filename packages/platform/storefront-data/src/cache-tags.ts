import type { HandledKind } from './keys.js';

// What the edge keeps storefront pages by (ADR-047): the storefront tags each page, and the
// publisher purges the tags of what it writes, so a page is forgotten when a document it was
// made from changes.

/** Every page of a shop has the shop's tag: its settings, theme and menus are on all of them. */
export function shopTag(shopId: string): string {
  return `hatti:${shopId}`;
}

/**
 * A product's, collection's or page's tag, by the handle a page finds it by: a page tagged with
 * a handle no document has yet is forgotten once one takes it.
 */
export function handleTag(shopId: string, kind: HandledKind, handle: string): string {
  return `hatti:${shopId}:${kind}:${handle}`;
}

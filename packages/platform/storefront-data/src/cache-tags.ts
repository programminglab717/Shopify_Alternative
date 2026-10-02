import { createHash } from 'node:crypto';
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

/**
 * A path's tag, on what the storefront answers there when it has no page at it: its 404 page, or
 * the URL redirect it follows instead (ADR-052). Forgotten when a redirect from the path comes,
 * changes or goes. The path, in {@link redirectKey}'s form, is hashed: tags are short and ASCII.
 */
export function pathTag(shopId: string, path: string): string {
  const hash = createHash('sha256').update(path).digest('base64url').slice(0, 22);
  return `hatti:${shopId}:path:${hash}`;
}

/**
 * A product image's tag, on every size and format the core serves of it (ADR-158): forgotten
 * when the image goes, whatever widths were asked for.
 */
export function imageTag(shopId: string, mediaId: string): string {
  return `hatti:${shopId}:image:${mediaId}`;
}

import type { PublicSite } from '@hatti/api';
import type { MediaRecord } from './records.js';
import type { ImageFormatValue } from './schema.js';

// Where products' images are (ADR-158): each ready image's clean copy in storage, under its
// shop's prefix, and the sizes and formats the core makes of it as browsers ask, beside it; and
// the path the core serves them at, on its public site.

/** Where the core serves products' images. */
export const IMAGES_PATH = '/images';

const EXTENSION: Readonly<Record<ImageFormatValue, string>> = { jpeg: 'jpg', png: 'png' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IMAGE_PATH = new RegExp(`^${IMAGES_PATH}/(${UUID})/(${UUID})/[a-z0-9-]{1,100}\\.(jpg|png)$`);

/**
 * The path a ready image is served at, its clean copy's size and format, named after its
 * product's handle for whoever saves it: /images/{shop}/{media}/lawn-suit.jpg. `?width=` asks for
 * a width, and the browser's Accept header picks the format. Null while it is not ready.
 */
export function imagePathOf(
  shopId: string,
  media: Pick<MediaRecord, 'id' | 'imageFormat'>,
  handle: string,
): string | null {
  if (media.imageFormat === null) return null;
  return `${IMAGES_PATH}/${shopId}/${media.id}/${handle || 'image'}.${EXTENSION[media.imageFormat]}`;
}

/**
 * The address an image is given out at, as an export's Image Src: where `site` serves it once
 * ready, whoever fetches it; else where it came from.
 */
export function imageAddressOf(
  site: PublicSite | undefined,
  shopId: string,
  media: MediaRecord,
  handle: string,
): string {
  const path = imagePathOf(shopId, media, handle);
  return path !== null && site ? site.url(path) : media.sourceUrl;
}

/** The shop, media and clean copy's format `path` names, if it is an image's path. */
export function parseImagePath(
  path: string,
): { shopId: string; mediaId: string; format: ImageFormatValue } | null {
  const match = IMAGE_PATH.exec(path);
  if (!match) return null;
  return { shopId: match[1]!, mediaId: match[2]!, format: match[3] === 'png' ? 'png' : 'jpeg' };
}

/** Where storage keeps a media's images: its clean copy, and every size and format made of it. */
export function imagesPrefixOf(shopId: string, mediaId: string): string {
  return `shops/${shopId}/images/${mediaId}/`;
}

/** The key of a media's clean copy. */
export function cleanImageKey(shopId: string, mediaId: string, format: ImageFormatValue): string {
  return `${imagesPrefixOf(shopId, mediaId)}clean.${EXTENSION[format]}`;
}

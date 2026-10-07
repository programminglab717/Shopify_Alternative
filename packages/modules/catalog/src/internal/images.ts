import type { PublicSite } from '@hatti/api';
import type { MediaCropRecord, MediaRecord } from './records.js';
import type { ImageFormatValue } from './schema.js';

// Where products' images are (ADR-158): each ready image's clean copy in storage, under its
// shop's prefix, and the sizes and formats the core makes of it as browsers ask, beside it; and
// the path the core serves them at, on its public site. A cropped image (ADR-257) is served from
// its crop's own clean copy, in a folder named after the crop beside the whole image's files, at
// a path naming the crop, so that each crop has an address of its own.

/** Where the core serves products' images. */
export const IMAGES_PATH = '/images';

const EXTENSION: Readonly<Record<ImageFormatValue, string>> = { jpeg: 'jpg', png: 'png' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CROP = 'crop-\\d{1,4}-\\d{1,4}-\\d{1,4}-\\d{1,4}';
const IMAGE_PATH = new RegExp(
  `^${IMAGES_PATH}/(${UUID})/(${UUID})/(?:(${CROP})/)?[a-z0-9-]{1,100}\\.(jpg|png)$`,
);

/** The name of a crop's folder, and of its part of its image's path: "crop-120-0-800-800". */
export function cropNameOf(crop: MediaCropRecord): string {
  return `crop-${crop.left}-${crop.top}-${crop.width}-${crop.height}`;
}

/**
 * The path a ready image is served at, its clean copy's size and format, or its crop's, named
 * after its product's handle for whoever saves it: /images/{shop}/{media}/lawn-suit.jpg, or
 * /images/{shop}/{media}/crop-0-150-800-800/lawn-suit.jpg once cropped. `?width=` asks for a
 * width, and the browser's Accept header picks the format. Null while it is not ready.
 */
export function imagePathOf(
  shopId: string,
  media: Pick<MediaRecord, 'id' | 'imageFormat' | 'crop'>,
  handle: string,
): string | null {
  if (media.imageFormat === null) return null;
  const crop = media.crop ? `${cropNameOf(media.crop)}/` : '';
  return `${IMAGES_PATH}/${shopId}/${media.id}/${crop}${handle || 'image'}.${EXTENSION[media.imageFormat]}`;
}

/** The size an image is shown at, in pixels: its crop's, else its own; null while not known. */
export function shownSizeOf(
  media: Pick<MediaRecord, 'width' | 'height' | 'crop'>,
): { width: number; height: number } | null {
  if (media.crop) return { width: media.crop.width, height: media.crop.height };
  return media.width === null || media.height === null
    ? null
    : { width: media.width, height: media.height };
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

/**
 * The shop, media, crop's name and clean copy's format `path` names, if it is an image's path;
 * the crop's null for the whole image.
 */
export function parseImagePath(
  path: string,
): { shopId: string; mediaId: string; crop: string | null; format: ImageFormatValue } | null {
  const match = IMAGE_PATH.exec(path);
  if (!match) return null;
  return {
    shopId: match[1]!,
    mediaId: match[2]!,
    crop: match[3] ?? null,
    format: match[4] === 'png' ? 'png' : 'jpeg',
  };
}

/**
 * Where storage keeps a media's images: its clean copy, every size and format made of it, and
 * its crops' folders. Everything under it goes with the media.
 */
export function imagesPrefixOf(shopId: string, mediaId: string): string {
  return `shops/${shopId}/images/${mediaId}/`;
}

/**
 * Where storage keeps what an image is shown from: the whole image's clean copy and what is made
 * of it, or, for the crop named `crop`, its folder's.
 */
export function shownImagesPrefixOf(shopId: string, mediaId: string, crop: string | null): string {
  return `${imagesPrefixOf(shopId, mediaId)}${crop === null ? '' : `${crop}/`}`;
}

/** The key of a media's clean copy, or of its crop's when `crop` names one. */
export function cleanImageKey(
  shopId: string,
  mediaId: string,
  format: ImageFormatValue,
  crop: string | null = null,
): string {
  return `${shownImagesPrefixOf(shopId, mediaId, crop)}clean.${EXTENSION[format]}`;
}

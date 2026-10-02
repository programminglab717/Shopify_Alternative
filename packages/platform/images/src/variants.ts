import sharp from 'sharp';
import type { CleanFormat } from './clean.js';

/**
 * The widths images are made at (ADR-158): a width asked for is made at the next of these, so an
 * image has few sizes, each a little wider than the last, from a cart's thumbnail to a zoomed
 * photo on a large screen.
 */
export const IMAGE_WIDTHS = [96, 192, 360, 540, 720, 960, 1200, 1500, 2048] as const;

/** The formats an image is shown in: AVIF or WebP where the browser takes them. */
export type VariantFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export const CONTENT_TYPES: Readonly<Record<VariantFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const EXTENSIONS: Readonly<Record<VariantFormat, string>> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
  png: 'png',
};

/** The width an image asked for at `width` is made at: the next of {@link IMAGE_WIDTHS}. */
export function widthFor(width: number): number {
  return IMAGE_WIDTHS.find((each) => each >= width) ?? IMAGE_WIDTHS.at(-1)!;
}

/**
 * The format to give a browser that sends `accept`, for an image whose clean copy is `clean`:
 * AVIF, the smallest, where it is taken; else WebP; else the copy's own, as a crawler fetching a
 * link's preview may ask.
 */
export function formatFor(accept: string | undefined, clean: CleanFormat): VariantFormat {
  const taken = new Set<string>();
  for (const part of (accept ?? '').toLowerCase().split(',')) {
    const [type = '', ...params] = part.split(';').map((piece) => piece.trim());
    // A type it says it will not take, at q=0, is not taken.
    if (!params.some((param) => /^q=0(?:\.0*)?$/.test(param))) taken.add(type);
  }
  if (taken.has('image/avif')) return 'avif';
  if (taken.has('image/webp')) return 'webp';
  return clean;
}

/**
 * The image `clean` is, at `width`, never wider than it is, or at its own width when `width` is
 * null, in `format`.
 */
export async function imageVariant(
  clean: Buffer,
  width: number | null,
  format: VariantFormat,
): Promise<Buffer> {
  const image = sharp(clean);
  if (width !== null) image.resize({ width, withoutEnlargement: true });
  switch (format) {
    case 'avif':
      // Quicker than libaom's default, for a little more weight: made when first asked for.
      return image.avif({ quality: 50, effort: 2, chromaSubsampling: '4:2:0' }).toBuffer();
    case 'webp':
      return image.webp({ quality: 80 }).toBuffer();
    case 'jpeg':
      return image.jpeg({ quality: 80, progressive: true }).toBuffer();
    case 'png':
      return image.png().toBuffer();
  }
}

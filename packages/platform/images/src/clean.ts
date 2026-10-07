import sharp from 'sharp';
import { IMAGE_SNIFF_BYTES, sniffImage } from './formats.js';

/** The most an image may weigh: 20 MiB, as an upload may. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The most pixels an image may have: one with more is refused before it is decoded. */
export const MAX_IMAGE_PIXELS = 50_000_000;

/** The longest side a clean copy keeps: a larger image is made smaller. */
export const MAX_IMAGE_SIDE = 4096;

/** How many times longer one side of an image may be than the other. */
export const MAX_ASPECT_RATIO = 20;

/** A clean copy's format: JPEG, or PNG for an image some of which is see-through. */
export type CleanFormat = 'jpeg' | 'png';

/** An image as Hatti keeps it, which every size and format it is shown in is made from. */
export interface CleanImage {
  body: Buffer;
  format: CleanFormat;
  width: number;
  height: number;
}

/** Why an image cannot be shown, in Shopify's `MediaErrorCode`'s words. */
export type ImageProblemCode =
  | 'UNSUPPORTED_IMAGE_FILE_TYPE'
  | 'INVALID_IMAGE_FILE_SIZE'
  | 'INVALID_IMAGE_RESOLUTION'
  | 'INVALID_IMAGE_ASPECT_RATIO'
  | 'IMAGE_PROCESSING_FAILURE';

export interface ImageProblem {
  code: ImageProblemCode;
  /** For the merchant: what is wrong with it, and what to do. */
  message: string;
}

export type CleanResult = { ok: true; image: CleanImage } | { ok: false; problem: ImageProblem };

/** How libvips reads what it is given: the first frame of an animation, failing on bad data. */
const INPUT = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' } as const;

/**
 * The clean copy of an image (ADR-158): told by its first bytes, checked, turned the way its
 * camera says it was held, made at most {@link MAX_IMAGE_SIDE} pixels a side, in sRGB, and
 * without its metadata, where a phone keeps where the photo was taken. JPEG at quality 90, unless
 * some of it is see-through: then PNG. An animation keeps its first frame.
 */
export async function cleanImage(bytes: Buffer): Promise<CleanResult> {
  if (bytes.length > MAX_IMAGE_BYTES) {
    return problem(
      'INVALID_IMAGE_FILE_SIZE',
      `The image is ${megabytes(bytes.length)} MB; it may be 20 MB at most`,
    );
  }
  const kind = sniffImage(bytes.subarray(0, IMAGE_SNIFF_BYTES));
  if (kind === 'heic') {
    return problem(
      'UNSUPPORTED_IMAGE_FILE_TYPE',
      'HEIC photos cannot be shown on the web: save it as a JPEG and add it again',
    );
  }
  if (!kind) {
    return problem('UNSUPPORTED_IMAGE_FILE_TYPE', 'It is not a JPEG, PNG, WebP, GIF or AVIF image');
  }
  try {
    // The header alone, before anything is decoded: any size, to say what size it is.
    const {
      width = 0,
      height = 0,
      hasAlpha,
    } = await sharp(bytes, {
      ...INPUT,
      limitInputPixels: false,
    }).metadata();
    if (width * height > MAX_IMAGE_PIXELS) {
      return problem(
        'INVALID_IMAGE_RESOLUTION',
        `The image is ${width} × ${height} pixels; it may have 50 megapixels at most`,
      );
    }
    if (Math.max(width, height) > MAX_ASPECT_RATIO * Math.min(width, height)) {
      return problem(
        'INVALID_IMAGE_ASPECT_RATIO',
        `The image is ${width} × ${height} pixels; one side may be at most 20 times the other`,
      );
    }
    const opaque = !hasAlpha || (await sharp(bytes, INPUT).stats()).isOpaque;
    const resized = sharp(bytes, INPUT).rotate().resize({
      width: MAX_IMAGE_SIDE,
      height: MAX_IMAGE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const { data, info } = await (
      opaque ? resized.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }) : resized.png()
    ).toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      image: {
        body: data,
        format: opaque ? 'jpeg' : 'png',
        width: info.width,
        height: info.height,
      },
    };
  } catch (error) {
    const reason = String((error as Error).message ?? error).split('\n')[0]!;
    return problem('IMAGE_PROCESSING_FAILURE', `The image could not be read: ${reason}`);
  }
}

/** The part of an image shown, in its clean copy's pixels from its top left. */
export interface ImageCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The clean copy of the part of an image a merchant cropped it to (ADR-257), from its whole clean
 * copy, in the same format: every size and format it is shown in is made from it, as from a
 * whole image's.
 */
export async function cropImage(
  clean: Buffer,
  crop: ImageCrop,
  format: CleanFormat,
): Promise<Buffer> {
  const part = sharp(clean, INPUT).extract(crop);
  return (format === 'jpeg' ? part.jpeg({ quality: 90 }) : part.png()).toBuffer();
}

function problem(code: ImageProblemCode, message: string): CleanResult {
  return { ok: false, problem: { code, message } };
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

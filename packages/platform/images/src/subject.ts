import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, type ImageCrop } from './clean.js';

// Auto-crop (CAT-21, ADR-503): most of a small shop's photos are of a product on a sheet or a
// wall, taken from too far, off centre, at whatever shape the phone made. The product is found
// against its backdrop, on a copy small enough to read in a few milliseconds, and framed in the
// shape the shop's theme shows its products in, with a margin round it. A photo whose backdrop is
// not plain, as a model's in a street is, is left as it is: what is the product in it is a guess.

/** The shapes a product's photos are framed in, width to height. */
export const ASPECT_RATIOS = {
  square: { width: 1, height: 1 },
  portrait_4_5: { width: 4, height: 5 },
  portrait_3_4: { width: 3, height: 4 },
  landscape_4_3: { width: 4, height: 3 },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

export const SUBJECT_LIMITS = {
  /** The longest side of the copy the product is looked for in, in pixels. */
  side: 256,
  /** How far a pixel's colour may be from the backdrop's, out of 441, and still be backdrop. */
  threshold: 40,
  /** The share of the border that must be backdrop for the backdrop to be plain. */
  plainBorder: 0.85,
  /** The share of a row or column that must be product for it to count: specks are not. */
  speck: 0.01,
  /** The margin round the product, as a share of its longer side. */
  margin: 0.08,
} as const;

/** Why a photo is not cropped to its product. */
export type SubjectProblem = 'BUSY_BACKGROUND' | 'NO_SUBJECT';

export type SubjectCrop =
  | {
      ok: true;
      /** The product framed, in the clean copy's pixels; null where all of it is the frame. */
      crop: ImageCrop | null;
    }
  | { ok: false; problem: SubjectProblem };

/**
 * The crop of a clean copy (ADR-158) that frames its product in `aspect`, with a margin round it,
 * as far as the image reaches: where the product and its margin are wider than the image allows,
 * the frame is as large as the image allows, centred on the product.
 */
export async function subjectCrop(clean: Buffer, aspect: AspectRatio): Promise<SubjectCrop> {
  const { width = 0, height = 0 } = await sharp(clean, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  const { data, info } = await sharp(clean, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({
      width: SUBJECT_LIMITS.side,
      height: SUBJECT_LIMITS.side,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const box = subjectBox(data, info.width, info.height, info.channels);
  if (!box.ok) return box;
  const scale = width / info.width;
  const scaleY = height / info.height;
  return {
    ok: true,
    crop: frame(
      {
        left: box.left * scale,
        top: box.top * scaleY,
        width: box.width * scale,
        height: box.height * scaleY,
      },
      { width, height },
      ASPECT_RATIOS[aspect],
    ),
  };
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the product is in `pixels`, raw and `channels` deep, against the backdrop: the colour most
 * of its border is. The bounds of the rows and columns at least {@link SUBJECT_LIMITS.speck} of
 * which differ from it.
 */
export function subjectBox(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
): ({ ok: true } & Box) | { ok: false; problem: SubjectProblem } {
  const at = (x: number, y: number) => (y * width + x) * channels;
  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(at(x, 0), at(x, height - 1));
  for (let y = 1; y < height - 1; y++) border.push(at(0, y), at(width - 1, y));
  // The backdrop: each channel's median over the border, which a corner's shadow doesn't move.
  const backdrop = [0, 1, 2].map((channel) => {
    const values = border.map((offset) => pixels[offset + channel]!).sort((a, b) => a - b);
    return values[values.length >> 1]!;
  });
  const differs = (offset: number) =>
    Math.hypot(
      pixels[offset]! - backdrop[0]!,
      pixels[offset + 1]! - backdrop[1]!,
      pixels[offset + 2]! - backdrop[2]!,
    ) > SUBJECT_LIMITS.threshold;
  const plain = border.filter((offset) => !differs(offset)).length / border.length;
  if (plain < SUBJECT_LIMITS.plainBorder) return { ok: false, problem: 'BUSY_BACKGROUND' };

  const rows = new Array<number>(height).fill(0);
  const columns = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (differs(at(x, y))) {
        rows[y]!++;
        columns[x]!++;
      }
    }
  }
  const counted = (counts: number[], across: number) => {
    const least = Math.max(1, Math.ceil(across * SUBJECT_LIMITS.speck));
    const first = counts.findIndex((count) => count >= least);
    if (first < 0) return null;
    return { first, last: counts.length - 1 - [...counts].reverse().findIndex((n) => n >= least) };
  };
  const ys = counted(rows, width);
  const xs = counted(columns, height);
  if (!ys || !xs) return { ok: false, problem: 'NO_SUBJECT' };
  return {
    ok: true,
    left: xs.first,
    top: ys.first,
    width: xs.last - xs.first + 1,
    height: ys.last - ys.first + 1,
  };
}

/**
 * The crop of an image `size` that frames `subject` in `aspect` with the margin round it: as
 * large as the image allows where it is not large enough, centred on the subject but within the
 * image. Null where it is the whole image, or within a pixel of it.
 */
export function frame(
  subject: Box,
  size: { width: number; height: number },
  aspect: { width: number; height: number },
): ImageCrop | null {
  const margin = SUBJECT_LIMITS.margin * Math.max(subject.width, subject.height);
  let width = subject.width + 2 * margin;
  let height = subject.height + 2 * margin;
  const ratio = aspect.width / aspect.height;
  if (width / height < ratio) width = height * ratio;
  else height = width / ratio;
  const fit = Math.min(1, size.width / width, size.height / height);
  width = Math.floor(width * fit);
  height = Math.floor(height * fit);
  const centreX = subject.left + subject.width / 2;
  const centreY = subject.top + subject.height / 2;
  const left = Math.round(Math.min(Math.max(centreX - width / 2, 0), size.width - width));
  const top = Math.round(Math.min(Math.max(centreY - height / 2, 0), size.height - height));
  if (width >= size.width - 1 && height >= size.height - 1) return null;
  return { left, top, width, height };
}

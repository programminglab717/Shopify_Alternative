/** The kinds of image Hatti takes, told by their first bytes rather than by a name or a header. */
export const IMAGE_KINDS = ['jpeg', 'png', 'webp', 'gif', 'avif'] as const;

export type ImageKind = (typeof IMAGE_KINDS)[number];

/**
 * What a file's first bytes say it is: an image Hatti takes, or "heic", the photos iPhones take,
 * which it does not (libvips reads them only with a decoder whose patents it leaves out).
 */
export type SniffedImage = ImageKind | 'heic';

/** How many of a file's first bytes tell what image it is. */
export const IMAGE_SNIFF_BYTES = 64;

/** The ISO base media brands of AVIF images, and of HEIF ones, iPhones' among them. */
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/** What image a file starting with `start` is; null when it is none Hatti knows. */
export function sniffImage(start: Uint8Array): SniffedImage | null {
  if (startsWith(start, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(start, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(start, ascii('GIF87a')) || startsWith(start, ascii('GIF89a'))) return 'gif';
  // "RIFF", the size, then "WEBP".
  if (startsWith(start, ascii('RIFF')) && startsWith(start.subarray(8), ascii('WEBP'))) {
    return 'webp';
  }
  // An ISO base media file: its size, "ftyp", then its major brand, a version and the brands it
  // is compatible with, each four letters.
  if (start.length >= 16 && startsWith(start.subarray(4), ascii('ftyp'))) {
    const size = Math.min(
      start.length,
      ((start[0]! << 24) | (start[1]! << 16) | (start[2]! << 8) | start[3]!) >>> 0,
    );
    const brands = [text(start, 8)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(text(start, at));
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heic';
  }
  return null;
}

function text(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

function ascii(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

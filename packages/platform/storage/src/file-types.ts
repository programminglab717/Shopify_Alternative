/**
 * The kinds of file the platform takes, told by their first bytes, so that a file is what it says
 * it is before anyone is shown it: images, PDFs, such as a receipt, and videos of products, MP4 or
 * QuickTime as phones record them (ADR-258).
 */
const KINDS = {
  'image/jpeg': { extension: 'jpg', starts: [[0xff, 0xd8, 0xff]] },
  'image/png': { extension: 'png', starts: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/webp': { extension: 'webp', starts: [] },
  'image/gif': { extension: 'gif', starts: [ascii('GIF87a'), ascii('GIF89a')] },
  'application/pdf': { extension: 'pdf', starts: [ascii('%PDF-')] },
  'video/mp4': { extension: 'mp4', starts: [] },
  'video/quicktime': { extension: 'mov', starts: [] },
} as const satisfies Record<string, { extension: string; starts: readonly (readonly number[])[] }>;

/**
 * The brands of the ISO base media files taken as videos, by the first box's major brand: MP4's
 * and phones' own, and QuickTime's. HEIC photos and AVIF images are such files too, under brands
 * of their own, and are not videos.
 */
const VIDEO_BRANDS: Readonly<Record<string, 'video/mp4' | 'video/quicktime'>> = {
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso4: 'video/mp4',
  iso5: 'video/mp4',
  iso6: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  'M4V ': 'video/mp4',
  M4VH: 'video/mp4',
  M4VP: 'video/mp4',
  MSNV: 'video/mp4',
  '3gp4': 'video/mp4',
  '3gp5': 'video/mp4',
  '3gp6': 'video/mp4',
  '3g2a': 'video/mp4',
  'qt  ': 'video/quicktime',
};

/** The most a video may weigh: 100 MiB. */
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

export type KnownContentType = keyof typeof KINDS;

export const KNOWN_CONTENT_TYPES = Object.keys(KINDS) as KnownContentType[];

/** How many of a file's first bytes tell what it is. */
export const SNIFF_BYTES = 12;

export function isKnownContentType(value: string): value is KnownContentType {
  return Object.hasOwn(KINDS, value);
}

/** What a file starting with `start` is; null for anything the platform doesn't take. */
export function sniffContentType(start: Uint8Array): KnownContentType | null {
  // "RIFF", the size, then "WEBP".
  if (startsWith(start, ascii('RIFF')) && startsWith(start.subarray(8), ascii('WEBP'))) {
    return 'image/webp';
  }
  // The first box's size, "ftyp", then its major brand.
  if (startsWith(start.subarray(4), ascii('ftyp')) && start.length >= 12) {
    return VIDEO_BRANDS[String.fromCharCode(...start.subarray(8, 12))] ?? null;
  }
  for (const type of KNOWN_CONTENT_TYPES) {
    if (KINDS[type].starts.some((prefix) => startsWith(start, prefix))) return type;
  }
  return null;
}

/** "jpg" for "image/jpeg". */
export function extensionOf(type: KnownContentType): string {
  return KINDS[type].extension;
}

/** Whether files of `type` are videos, which may weigh more than the rest. */
export function isVideoType(type: KnownContentType): boolean {
  return type.startsWith('video/');
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

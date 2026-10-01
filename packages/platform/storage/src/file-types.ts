/**
 * The kinds of file the platform takes, told by their first bytes, so that a file is what it says
 * it is before anyone is shown it: images, and PDFs, such as a receipt.
 */
const KINDS = {
  'image/jpeg': { extension: 'jpg', starts: [[0xff, 0xd8, 0xff]] },
  'image/png': { extension: 'png', starts: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/webp': { extension: 'webp', starts: [] },
  'image/gif': { extension: 'gif', starts: [ascii('GIF87a'), ascii('GIF89a')] },
  'application/pdf': { extension: 'pdf', starts: [ascii('%PDF-')] },
} as const satisfies Record<string, { extension: string; starts: readonly (readonly number[])[] }>;

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
  for (const type of KNOWN_CONTENT_TYPES) {
    if (KINDS[type].starts.some((prefix) => startsWith(start, prefix))) return type;
  }
  return null;
}

/** "jpg" for "image/jpeg". */
export function extensionOf(type: KnownContentType): string {
  return KINDS[type].extension;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

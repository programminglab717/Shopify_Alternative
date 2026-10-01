/**
 * The kinds of file a shop may upload, by MIME type: images, and PDFs, such as a receipt. Each is
 * told by its first bytes, so a file is what it says it is before anyone is shown it.
 */
const TYPES = {
  'image/jpeg': { extension: 'jpg', starts: [[0xff, 0xd8, 0xff]] },
  'image/png': { extension: 'png', starts: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/webp': { extension: 'webp', starts: [] },
  'image/gif': { extension: 'gif', starts: [ascii('GIF87a'), ascii('GIF89a')] },
  'application/pdf': { extension: 'pdf', starts: [ascii('%PDF-')] },
} as const satisfies Record<string, { extension: string; starts: readonly (readonly number[])[] }>;

export type FileTypeValue = keyof typeof TYPES;

export const FILE_TYPES = Object.keys(TYPES) as FileTypeValue[];

/** How many of a file's first bytes tell its type. */
export const SNIFF_BYTES = 12;

export function isFileType(value: string): value is FileTypeValue {
  return Object.hasOwn(TYPES, value);
}

/** Whether a file starting with `start` is of `type`. */
export function looksLike(type: FileTypeValue, start: Uint8Array): boolean {
  if (type === 'image/webp') {
    // "RIFF", the size, then "WEBP".
    return startsWith(start, ascii('RIFF')) && startsWith(start.subarray(8), ascii('WEBP'));
  }
  return TYPES[type].starts.some((prefix) => startsWith(start, prefix));
}

/**
 * A file's name as the last part of its key: letters, digits, hyphens and underscores, with its
 * type's extension, so that storage and browsers read it one way.
 */
export function keyName(filename: string, type: FileTypeValue): string {
  const base = filename
    .normalize('NFKD')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'file'}.${TYPES[type].extension}`;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

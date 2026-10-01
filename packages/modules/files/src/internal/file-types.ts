import {
  KNOWN_CONTENT_TYPES,
  extensionOf,
  isKnownContentType,
  sniffContentType,
  type KnownContentType,
} from '@hatti/storage';

/**
 * The kinds of file a shop may upload, by MIME type: images, and PDFs, such as a receipt. Each is
 * told by its first bytes, so a file is what it says it is before anyone is shown it.
 */
export type FileTypeValue = KnownContentType;

export const FILE_TYPES: readonly FileTypeValue[] = KNOWN_CONTENT_TYPES;

export { SNIFF_BYTES } from '@hatti/storage';

export function isFileType(value: string): value is FileTypeValue {
  return isKnownContentType(value);
}

/** Whether a file starting with `start` is of `type`. */
export function looksLike(type: FileTypeValue, start: Uint8Array): boolean {
  return sniffContentType(start) === type;
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
  return `${base || 'file'}.${extensionOf(type)}`;
}

import type { Readable } from 'node:stream';
import { MAX_VIDEO_UPLOAD_BYTES, isVideoType, type KnownContentType } from './file-types.js';

/** The most a file uploaded in one request may weigh, but a video: 20 MiB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The most a file of `type` may weigh: a video 100 MiB, anything else 20 MiB. */
export function maxUploadBytesOf(type: KnownContentType): number {
  return isVideoType(type) ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

/** The bytes from `start` to `end` of a file, both counted, as an HTTP range names them. */
export interface ByteRange {
  start: number;
  end: number;
}

/** A file kept under a key: how much it weighs and what it is. */
export interface StoredObject {
  size: number;
  contentType: string | null;
}

/** A request a client makes itself, such as an upload straight to storage. */
export interface SignedRequest {
  url: string;
  method: 'PUT';
  /** To send with it as given; its body must weigh what was signed for. */
  headers: Record<string, string>;
}

// Keys are paths of plain segments: no "." or "..", nothing a file system or URL reads otherwise.
const KEY = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Whether `key` may name an object: "shops/{shopId}/files/{fileId}/receipt.jpg". */
export function isObjectKey(key: string): boolean {
  return key.length <= 1024 && KEY.test(key);
}

export function assertObjectKey(key: string): void {
  if (!isObjectKey(key)) throw new Error(`Not an object key: ${JSON.stringify(key)}`);
}

/** Whether `prefix` names the objects under a key's path: "shops/{shopId}/images/{mediaId}/". */
export function isObjectPrefix(prefix: string): boolean {
  return prefix.endsWith('/') && isObjectKey(prefix.slice(0, -1));
}

export function assertObjectPrefix(prefix: string): void {
  if (!isObjectPrefix(prefix)) throw new Error(`Not an object prefix: ${JSON.stringify(prefix)}`);
}

/**
 * Where the platform keeps files, by key, such as "shops/{shopId}/files/{fileId}/receipt.jpg":
 * R2 in production, a directory in development (ADR-079). Clients upload files straight to it and
 * read them from it through short-lived signed URLs; the core reads and writes them itself only
 * as it must. A shop's files are kept under its own prefix, and none are public.
 */
export abstract class ObjectStorage {
  /**
   * A request that puts `contentLength` bytes of `contentType` under `key`, which its client makes
   * itself within `expiresIn` seconds.
   */
  abstract signUpload(
    key: string,
    file: { contentType: string; contentLength: number },
    expiresIn: number,
  ): SignedRequest;

  /**
   * A URL that gives the file under `key` for `expiresIn` seconds, shown in the browser rather
   * than downloaded, as `filename` when given.
   */
  abstract signDownload(key: string, expiresIn: number, options?: { filename?: string }): string;

  /** Where `key` is, unsigned: what a staged upload's resource URL says. */
  abstract locationOf(key: string): string;

  /** The key `location` names, if it is one of this storage's; null otherwise. */
  abstract keyOf(location: string): string | null;

  /** What is kept under `key`; null when nothing is. */
  abstract head(key: string): Promise<StoredObject | null>;

  /** The first `length` bytes kept under `key`, to tell what it is; null when nothing is. */
  abstract readStart(key: string, length: number): Promise<Buffer | null>;

  /** The whole file kept under `key`, with its type; null when nothing is. */
  abstract read(key: string): Promise<{ body: Buffer; contentType: string | null } | null>;

  /**
   * The file kept under `key` as it is read, from `range` alone when given, which must lie within
   * it: a video sent as browsers ask for it, never held whole. Null when nothing is kept there.
   */
  abstract stream(key: string, range?: ByteRange): Promise<Readable | null>;

  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** Removes what is kept under `key`, if anything is. */
  abstract delete(key: string): Promise<void>;

  /** Removes everything kept under `prefix`, a path ending in "/", if anything is. */
  abstract deletePrefix(prefix: string): Promise<void>;
}

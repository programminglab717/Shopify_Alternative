import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  ObjectStorage,
  assertObjectKey,
  assertObjectPrefix,
  isObjectKey,
  type ByteRange,
  type SignedRequest,
  type StoredObject,
} from './object-storage.js';
import { uriEncode } from './sigv4.js';

export interface LocalStorageOptions {
  /** Where its files are kept. */
  directory: string;
  /** Where the core serves them, which `signUpload` and `signDownload` point at. */
  baseUrl: string;
  /** What its URLs are signed with: 32 bytes or more. */
  secret: string | Buffer;
  /** The time it signs and checks at; now unless given. */
  now?: () => Date;
}

/** What a URL `LocalStorage` signed lets its holder do. */
export type LocalGrant =
  | { method: 'PUT'; contentType: string; contentLength: number }
  | { method: 'GET'; filename: string | null };

/**
 * Files kept in a directory, for development and tests: the core serves them at `baseUrl`, taking
 * uploads and giving files only through URLs this storage signed, as R2 does through its own.
 * Each file's type is kept beside it.
 */
export class LocalStorage extends ObjectStorage {
  readonly #base: string;

  constructor(private readonly options: LocalStorageOptions) {
    super();
    if (Buffer.byteLength(options.secret) < 32) {
      throw new Error('LocalStorage needs a secret of 32 bytes or more');
    }
    this.#base = `${options.baseUrl.replace(/\/+$/, '')}/`;
  }

  signUpload(
    key: string,
    file: { contentType: string; contentLength: number },
    expiresIn: number,
  ): SignedRequest {
    const params = this.#signed('PUT', key, expiresIn, {
      type: file.contentType,
      length: String(file.contentLength),
    });
    return {
      url: `${this.locationOf(key)}?${params}`,
      method: 'PUT',
      headers: { 'content-type': file.contentType },
    };
  }

  signDownload(key: string, expiresIn: number, options: { filename?: string } = {}): string {
    const params = this.#signed(
      'GET',
      key,
      expiresIn,
      options.filename ? { filename: options.filename } : {},
    );
    return `${this.locationOf(key)}?${params}`;
  }

  /**
   * What the URL for `method` on `key`, with `query`, lets its holder do; null when this storage
   * did not sign it so, or it expired.
   */
  verify(
    method: 'PUT' | 'GET',
    key: string,
    query: Record<string, string | undefined>,
  ): LocalGrant | null {
    if (!isObjectKey(key)) return null;
    const { signature, expires, ...rest } = query;
    if (!signature || !expires || !/^\d{1,12}$/.test(expires)) return null;
    if (Number(expires) * 1000 < this.#now().getTime()) return null;
    const fields = Object.fromEntries(
      Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const expected = Buffer.from(this.#signature(method, key, { ...fields, expires }));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (method === 'GET') return { method, filename: fields.filename ?? null };
    const length = Number(fields.length);
    if (!fields.type || !Number.isSafeInteger(length)) return null;
    return { method, contentType: fields.type, contentLength: length };
  }

  locationOf(key: string): string {
    assertObjectKey(key);
    return `${this.#base}${uriEncode(key, true)}`;
  }

  keyOf(location: string): string | null {
    if (!location.startsWith(this.#base)) return null;
    try {
      const key = decodeURIComponent(location.slice(this.#base.length));
      return isObjectKey(key) ? key : null;
    } catch {
      return null;
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    const path = this.#path(key);
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) return null;
    return { size: stats.size, contentType: await this.#typeOf(path) };
  }

  async readStart(key: string, length: number): Promise<Buffer | null> {
    const file = await open(this.#path(key), 'r').catch(() => null);
    if (!file) return null;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  /** The whole file under `key`, with its type; null when there is none. */
  async read(key: string): Promise<{ body: Buffer; contentType: string | null } | null> {
    const path = this.#path(key);
    const body = await readFile(path).catch(() => null);
    return body && { body, contentType: await this.#typeOf(path) };
  }

  async stream(key: string, range?: ByteRange): Promise<Readable | null> {
    const path = this.#path(key);
    if (!(await stat(path).catch(() => null))?.isFile()) return null;
    return createReadStream(path, range && { start: range.start, end: range.end });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.type`, contentType);
  }

  async delete(key: string): Promise<void> {
    const path = this.#path(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertObjectPrefix(prefix);
    await rm(this.#path(prefix.slice(0, -1)), { recursive: true, force: true });
  }

  #path(key: string): string {
    assertObjectKey(key);
    return join(this.options.directory, ...key.split('/'));
  }

  async #typeOf(path: string): Promise<string | null> {
    return readFile(`${path}.type`, 'utf8').catch(() => null);
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #signed(
    method: 'PUT' | 'GET',
    key: string,
    expiresIn: number,
    fields: Record<string, string>,
  ): URLSearchParams {
    const expires = String(Math.floor(this.#now().getTime() / 1000) + expiresIn);
    const params = new URLSearchParams({ ...fields, expires });
    params.set('signature', this.#signature(method, key, { ...fields, expires }));
    return params;
  }

  #signature(method: string, key: string, fields: Record<string, string>): string {
    const lines = Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      // Encoded, so that no value can pass for another field.
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    return createHmac('sha256', this.options.secret)
      .update([method, key, ...lines].join('\n'))
      .digest('base64url');
  }
}

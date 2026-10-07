import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import {
  ObjectStorage,
  assertObjectKey,
  assertObjectPrefix,
  isObjectKey,
  type ByteRange,
  type SignedRequest,
  type StoredObject,
} from './object-storage.js';
import {
  EMPTY_PAYLOAD_SHA256,
  presignUrl,
  sha256Hex,
  signRequest,
  uriEncode,
  type Credentials,
  type SigningOptions,
} from './sigv4.js';

export interface S3StorageOptions {
  /** The S3 API's address, without the bucket: "https://{account}.r2.cloudflarestorage.com". */
  endpoint: string;
  bucket: string;
  /** "auto" for R2. */
  region: string;
  credentials: Credentials;
  /** What makes its requests; the platform's `fetch` unless given. */
  fetch?: typeof fetch;
  /** The time it signs at; now unless given. */
  now?: () => Date;
}

/**
 * Files kept in a bucket through the S3 API, as R2 serves it (ADR-007): addressed by path,
 * "{endpoint}/{bucket}/{key}", and signed with Signature Version 4.
 */
export class S3Storage extends ObjectStorage {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: S3StorageOptions) {
    super();
    this.#base = `${options.endpoint.replace(/\/+$/, '')}/${uriEncode(options.bucket)}/`;
    this.#fetch = options.fetch ?? fetch;
  }

  signUpload(
    key: string,
    file: { contentType: string; contentLength: number },
    expiresIn: number,
  ): SignedRequest {
    const headers = { 'content-type': file.contentType };
    const url = presignUrl('PUT', this.#url(key), {
      ...this.#signing(),
      expiresIn,
      headers: { ...headers, 'content-length': String(file.contentLength) },
    });
    return { url, method: 'PUT', headers };
  }

  signDownload(key: string, expiresIn: number, options: { filename?: string } = {}): string {
    const url = this.#url(key);
    if (options.filename) {
      url.searchParams.set('response-content-disposition', inlineDisposition(options.filename));
    }
    return presignUrl('GET', url, { ...this.#signing(), expiresIn });
  }

  locationOf(key: string): string {
    return this.#url(key).toString();
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
    const response = await this.#request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) throw await failure('HEAD', key, response);
    return {
      size: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type'),
    };
  }

  async readStart(key: string, length: number): Promise<Buffer | null> {
    const response = await this.#request('GET', key, { range: `bytes=0-${length - 1}` });
    if (response.status === 404) return null;
    // An empty object has no range to give.
    if (response.status === 416) return Buffer.alloc(0);
    if (!response.ok) throw await failure('GET', key, response);
    return Buffer.from(await response.arrayBuffer()).subarray(0, length);
  }

  async read(key: string): Promise<{ body: Buffer; contentType: string | null } | null> {
    const response = await this.#request('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) throw await failure('GET', key, response);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
    };
  }

  async stream(key: string, range?: ByteRange): Promise<Readable | null> {
    const response = await this.#request(
      'GET',
      key,
      range ? { range: `bytes=${range.start}-${range.end}` } : {},
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await failure('GET', key, response);
    return response.body ? Readable.fromWeb(response.body as ReadableStream) : Readable.from([]);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.#request(
      'PUT',
      key,
      { 'content-type': contentType, 'content-length': String(body.length) },
      body,
    );
    if (!response.ok) throw await failure('PUT', key, response);
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request('DELETE', key);
    if (!response.ok && response.status !== 404) throw await failure('DELETE', key, response);
  }

  /** Lists the keys under `prefix`, a page at a time (ListObjectsV2), and removes each. */
  async deletePrefix(prefix: string): Promise<void> {
    assertObjectPrefix(prefix);
    let token: string | null = null;
    do {
      const url = new URL(this.#base);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await this.#send('GET', url);
      if (!response.ok) throw await failure('LIST', prefix, response);
      const listing = await response.text();
      for (const [, key] of listing.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const name = unescapeXml(key!);
        if (name.startsWith(prefix) && isObjectKey(name)) await this.delete(name);
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(listing)
        ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(listing)?.[1] ?? null)
        : null;
      if (token) token = unescapeXml(token);
    } while (token);
  }

  #url(key: string): URL {
    assertObjectKey(key);
    return new URL(`${this.#base}${uriEncode(key, true)}`);
  }

  #signing(): SigningOptions {
    return {
      credentials: this.options.credentials,
      region: this.options.region,
      date: this.options.now?.() ?? new Date(),
    };
  }

  #request(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    return this.#send(method, this.#url(key), headers, body);
  }

  async #send(
    method: string,
    url: URL,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
    const signed = signRequest(method, url, headers, payloadHash, this.#signing());
    return this.#fetch(url, {
      method,
      headers: { ...headers, ...signed },
      ...(body && { body: new Uint8Array(body) }),
    });
  }
}

/** Shown in the browser, saved as `filename` if saved: RFC 6266's form, for any characters. */
export function inlineDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${uriEncode(filename)}`;
}

/** XML's five entities, as a listing escapes keys. */
function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) =>
    name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'quot' ? '"' : name === 'apos' ? "'" : '&',
  );
}

async function failure(method: string, key: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  return new Error(`Storage ${method} ${key} failed: ${response.status} ${detail}`.trim());
}

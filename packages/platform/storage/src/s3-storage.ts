import {
  ObjectStorage,
  assertObjectKey,
  isObjectKey,
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

  async #request(
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Response> {
    const url = this.#url(key);
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

async function failure(method: string, key: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  return new Error(`Storage ${method} ${key} failed: ${response.status} ${detail}`.trim());
}

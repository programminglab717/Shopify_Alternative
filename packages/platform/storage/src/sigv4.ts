import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, as S3 and R2 check it: requests signed in their `authorization`
 * header, and URLs signed in their query (presigned), for the S3 service; and requests to other
 * services of AWS's, as SES.
 */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigningOptions {
  credentials: Credentials;
  /** "auto" for R2; "us-east-1" and the like for S3. */
  region: string;
  /** When it is signed: requests and URLs are good for 15 minutes, or `expiresIn`, from then. */
  date: Date;
  service?: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** What a presigned URL's payload is: its client sends whatever it sends. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** The SHA-256 of nothing, in hex: the payload of a GET, HEAD or DELETE. */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex('');

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * RFC 3986 encoding, as Signature Version 4 wants it: unreserved characters as they are, every
 * other byte of their UTF-8 as %XX in upper case; "/" kept in a path.
 */
export function uriEncode(value: string, path = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return path ? encoded.replace(/%2F/g, '/') : encoded;
}

/** "20130524T000000Z". */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * The canonical request's query: each name and value encoded, sorted by name and then value. A
 * URL's own parameters, such as `response-content-disposition`, count with the signature's.
 */
function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * The canonical request's path: as the URL has it for S3, and encoded once more for any other
 * service, as Signature Version 4 has it: an address in SES's paths, as `a%40b.pk`, signs as
 * `a%2540b.pk`.
 */
export function canonicalPath(url: URL, options: Pick<SigningOptions, 'service'>): string {
  return (options.service ?? 's3') === 's3' ? url.pathname : uriEncode(url.pathname, true);
}

/** Headers by lower-cased name, their values trimmed and their inner spaces collapsed. */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

function signature(
  options: SigningOptions,
  canonicalRequest: string,
): { scope: string; signature: string } {
  const service = options.service ?? 's3';
  const stamp = amzDate(options.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${options.region}/${service}/aws4_request`;
  const toSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = [day, options.region, service, 'aws4_request'].reduce<string | Buffer>(
    (previous, part) => hmac(previous, part),
    `AWS4${options.credentials.secretAccessKey}`,
  );
  return { scope, signature: createHmac('sha256', key).update(toSign).digest('hex') };
}

/**
 * `url` signed in its query for `method`, good for `expiresIn` seconds from `options.date`: the
 * host and `headers` are signed, so a client must send those headers as given.
 */
export function presignUrl(
  method: string,
  url: URL,
  options: SigningOptions & { expiresIn: number; headers?: Record<string, string> },
): string {
  const headers = { ...options.headers, host: url.host };
  const { canonical, signed } = canonicalHeaders(headers);
  const service = options.service ?? 's3';
  const stamp = amzDate(options.date);
  const params: [string, string][] = [
    ...url.searchParams,
    ['X-Amz-Algorithm', ALGORITHM],
    [
      'X-Amz-Credential',
      `${options.credentials.accessKeyId}/${stamp.slice(0, 8)}/${options.region}/${service}/aws4_request`,
    ],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(options.expiresIn)],
    ['X-Amz-SignedHeaders', signed],
  ];
  const query = canonicalQuery(params);
  const canonicalRequest = [method, url.pathname, query, canonical, signed, UNSIGNED_PAYLOAD].join(
    '\n',
  );
  const { signature: hex } = signature(options, canonicalRequest);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${hex}`;
}

/**
 * The headers that sign a request for `method` to `url` with `headers` and a payload whose
 * SHA-256 is `payloadHash`: `x-amz-date`, `x-amz-content-sha256` and `authorization`, to send
 * with `headers`.
 */
export function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  options: SigningOptions,
): Record<string, string> {
  const added = { 'x-amz-date': amzDate(options.date), 'x-amz-content-sha256': payloadHash };
  const { canonical, signed } = canonicalHeaders({ ...headers, ...added, host: url.host });
  const canonicalRequest = [
    method,
    canonicalPath(url, options),
    canonicalQuery([...url.searchParams]),
    canonical,
    signed,
    payloadHash,
  ].join('\n');
  const { scope, signature: hex } = signature(options, canonicalRequest);
  return {
    ...added,
    authorization:
      `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signed}, Signature=${hex}`,
  };
}

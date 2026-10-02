import type { LookupAddress } from 'node:dns';
import { lookup as systemLookup } from 'node:dns/promises';
import { STATUS_CODES, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { MAX_IMAGE_BYTES } from './clean.js';

/**
 * Addresses on no public network (RFC 6890 and its updates): this host, private networks, shared
 * address space, link-local ones (cloud metadata among them), documentation, benchmarking,
 * multicast and reserved ones; in IPv6 also unique local and site-local ones, and the forms that
 * carry an IPv4 address inside (IPv4-compatible, NAT64, 6to4, Teredo). IPv4-mapped addresses
 * are checked as the IPv4 address they carry.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address` is on the public internet, where the fetcher may connect. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface ImageFetcherOptions {
  /** The most a response may weigh: {@link MAX_IMAGE_BYTES} unless given. */
  maxBytes?: number;
  /** How long a fetch may take, redirects and all: 30 seconds unless given. */
  timeoutMs?: number;
  /** Redirects followed: 3 unless given. */
  maxRedirects?: number;
  /** The schemes fetched: https alone unless given. */
  protocols?: readonly string[];
  /** Whether it may connect to `address`: {@link isPublicAddress} unless given. */
  allowAddress?: (address: string) => boolean;
  /** Every address of `host`: the system's resolver's unless given. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

/** Why an image was not fetched; `transient` when trying again later may fetch it. */
export interface FetchFailure {
  ok: false;
  transient: boolean;
  code: 'IMAGE_DOWNLOAD_FAILURE' | 'INVALID_IMAGE_FILE_SIZE';
  message: string;
}

export type FetchResult = { ok: true; body: Buffer } | FetchFailure;

/** Raised from a lookup that finds the host on no public network. */
class NotPublicError extends Error {}

const USER_AGENT = 'HattiImageFetcher/1.0 (+https://hatti.pk)';

/**
 * Fetches the images merchants give by URL (ADR-158), as a server must when its users name what
 * it fetches: never from a private network, its own and cloud metadata among them. Every address
 * a host has must be public, and the connection is made to the addresses checked, so a name that
 * resolves elsewhere a moment later gains nothing; each redirect is checked as the first URL was.
 * A response may weigh 20 MB and take 30 seconds, redirects and all.
 */
export class ImageFetcher {
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #protocols: readonly string[];
  readonly #allow: (address: string) => boolean;
  readonly #resolve: (host: string) => Promise<LookupAddress[]>;

  constructor(options: ImageFetcherOptions = {}) {
    this.#maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRedirects = options.maxRedirects ?? 3;
    this.#protocols = options.protocols ?? ['https:'];
    this.#allow = options.allowAddress ?? isPublicAddress;
    this.#resolve =
      options.resolve ?? ((host) => systemLookup(host, { all: true, verbatim: true }));
  }

  async fetch(url: string): Promise<FetchResult> {
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return failure(false, 'It is not a URL');
    }
    for (let redirects = 0; ; redirects += 1) {
      const refused = this.#refusal(target);
      if (refused) return failure(false, refused);
      const answer = await this.#get(target, deadline);
      if (!('location' in answer)) return answer;
      if (redirects >= this.#maxRedirects) {
        return failure(false, `It redirected more than ${this.#maxRedirects} times`);
      }
      try {
        target = new URL(answer.location, target);
      } catch {
        return failure(false, 'It redirected to something that is not a URL');
      }
    }
  }

  /** Why `url` is not fetched, if it is not. */
  #refusal(url: URL): string | null {
    if (!this.#protocols.includes(url.protocol)) return 'Only https addresses are fetched';
    if (url.username || url.password) return 'An address with a password is not fetched';
    // Connections to a host's addresses are checked as they are made; an address given as the
    // host is never looked up, so it is checked here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !this.#allow(literal)) return PRIVATE;
    return null;
  }

  /** One request: the image, a redirect's location, or why neither. */
  #get(url: URL, deadline: AbortSignal): Promise<FetchResult | { location: string }> {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      const outgoing = request(
        url,
        {
          method: 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'image/*',
            'accept-encoding': 'identity',
          },
          // A connection of its own, so every request looks its host up, and checks it.
          agent: false,
          lookup: (host, options, callback) => {
            this.#resolve(host).then(
              (addresses) => {
                if (
                  addresses.length === 0 ||
                  !addresses.every((each) => this.#allow(each.address))
                ) {
                  callback(new NotPublicError(PRIVATE), '', 0);
                } else if (options.all) {
                  callback(null, addresses);
                } else {
                  callback(null, addresses[0]!.address, addresses[0]!.family);
                }
              },
              (error: NodeJS.ErrnoException) => callback(error, '', 0),
            );
          },
          signal: deadline,
        },
        (response) => {
          void this.#read(response, deadline).then(resolve);
        },
      );
      outgoing.on('error', (error) => {
        resolve(
          error instanceof NotPublicError ? failure(false, PRIVATE) : unreachable(error, deadline),
        );
      });
      outgoing.end();
    });
  }

  async #read(
    response: IncomingMessage,
    deadline: AbortSignal,
  ): Promise<FetchResult | { location: string }> {
    const status = response.statusCode ?? 0;
    const { location } = response.headers;
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      response.resume();
      return { location };
    }
    if (status !== 200) {
      response.resume();
      const transient = status === 408 || status === 429 || status >= 500;
      return failure(
        transient,
        `Its server answered ${status} ${STATUS_CODES[status] ?? ''}`.trim(),
      );
    }
    const tooBig = failure(false, 'The image is over 20 MB', 'INVALID_IMAGE_FILE_SIZE');
    if (Number(response.headers['content-length'] ?? 0) > this.#maxBytes) {
      response.destroy();
      return tooBig;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > this.#maxBytes) {
          response.destroy();
          return tooBig;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      return unreachable(error as Error, deadline);
    }
    return { ok: true, body: Buffer.concat(chunks) };
  }
}

const PRIVATE = 'Its address is on a private network, which Hatti does not fetch from';

function failure(
  transient: boolean,
  message: string,
  code: FetchFailure['code'] = 'IMAGE_DOWNLOAD_FAILURE',
): FetchFailure {
  return { ok: false, transient, code, message };
}

/** A request that failed on the way: worth trying again later. */
function unreachable(error: Error, deadline: AbortSignal): FetchFailure {
  if (deadline.aborted) return failure(true, 'Its server took too long to answer');
  const reason = (error as NodeJS.ErrnoException).code ?? error.message;
  return failure(true, `It could not be fetched: ${reason}`);
}

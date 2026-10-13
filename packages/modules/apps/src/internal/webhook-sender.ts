import type { LookupAddress } from 'node:dns';
import { lookup as systemLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from '@hatti/api';
import { WEBHOOK_LIMITS } from './webhooks.js';

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** How a try went: the app's HTTP status, or why no answer came. */
export interface WebhookOutcome {
  status: number | null;
  error: string | null;
}

/** Posts a webhook to an app. The worker's is {@link HttpWebhookSender}; tests give their own. */
export abstract class WebhookSender {
  abstract send(request: WebhookRequest): Promise<WebhookOutcome>;
}

export interface HttpWebhookSenderOptions {
  /** How long an app has to answer: {@link WEBHOOK_LIMITS.timeoutMs} unless given. */
  timeoutMs?: number;
  /** The schemes posted to: https alone unless given. */
  protocols?: readonly string[];
  /** Whether it may connect to `address`: public ones alone unless given. */
  allowAddress?: (address: string) => boolean;
  /** Every address of `host`: the system's resolver's unless given. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

class NotPublicError extends Error {}

const PRIVATE = 'Its address is not on the public internet';
const USER_AGENT = 'Hatti-Webhooks/1.0 (+https://hatti.pk)';
/** What of an answer is read before it is let go: none of it is kept. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * Posts webhooks as a server must when its users name where it posts (ADR-397, as ADR-158 fetches
 * images): to https addresses on the public internet alone, every address a host has checked and
 * the connection made to those checked; a redirect is not followed, and an app has five seconds to
 * answer. Any 2xx is delivered.
 */
export class HttpWebhookSender extends WebhookSender {
  readonly #timeoutMs: number;
  readonly #protocols: readonly string[];
  readonly #allow: (address: string) => boolean;
  readonly #resolve: (host: string) => Promise<LookupAddress[]>;

  constructor(options: HttpWebhookSenderOptions = {}) {
    super();
    this.#timeoutMs = options.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs;
    this.#protocols = options.protocols ?? ['https:'];
    this.#allow = options.allowAddress ?? isPublicAddress;
    this.#resolve =
      options.resolve ?? ((host) => systemLookup(host, { all: true, verbatim: true }));
  }

  send({ url, body, headers }: WebhookRequest): Promise<WebhookOutcome> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return Promise.resolve({ status: null, error: 'It is not an address' });
    }
    if (!this.#protocols.includes(target.protocol)) {
      return Promise.resolve({ status: null, error: 'Only https addresses are posted to' });
    }
    if (target.username || target.password) {
      return Promise.resolve({ status: null, error: 'An address with a password is not used' });
    }
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !this.#allow(literal)) {
      return Promise.resolve({ status: null, error: PRIVATE });
    }
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      const outgoing = request(
        target,
        {
          method: 'POST',
          headers: {
            ...headers,
            'user-agent': USER_AGENT,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body).toString(),
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
          let read = 0;
          response.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > MAX_ANSWER_BYTES) response.destroy();
          });
          const done = () => {
            const status = response.statusCode ?? 0;
            resolve(
              status >= 200 && status < 300
                ? { status, error: null }
                : {
                    status,
                    error:
                      status >= 300 && status < 400
                        ? 'It answered with a redirect, which is not followed'
                        : `It answered ${status}`,
                  },
            );
          };
          response.on('end', done);
          response.on('close', done);
          response.on('error', done);
        },
      );
      outgoing.on('error', (error) => {
        resolve({
          status: null,
          error:
            error instanceof NotPublicError
              ? PRIVATE
              : deadline.aborted
                ? `No answer within ${this.#timeoutMs / 1000} seconds`
                : `It could not be reached: ${error.message}`,
        });
      });
      outgoing.end(body);
    });
  }
}

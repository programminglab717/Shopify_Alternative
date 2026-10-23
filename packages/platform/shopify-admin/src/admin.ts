/**
 * The version of Shopify's Admin API Hatti asks: each is answered for a year from its release,
 * so this moves forward at least once a year (ADR-749).
 */
export const SHOPIFY_API_VERSION = '2026-07';

/**
 * What the store's owner gives Hatti from an app of their store's: the Admin API access token of
 * a custom app made in the store's admin before 2026, or the client ID and secret of an app made
 * in Shopify's Dev Dashboard and installed on the store, which Shopify exchanges for a token that
 * lasts a day. Neither is kept.
 */
export type ShopifyCredentials =
  { accessToken: string } | { clientId: string; clientSecret: string };

export interface ShopifyAdminOptions {
  /** The store's own address, as {@link shopDomainOf} gives it. */
  shop: string;
  credentials: ShopifyCredentials;
  /** {@link SHOPIFY_API_VERSION} unless given. */
  apiVersion?: string;
  fetch?: typeof fetch;
  /** How long one request may take; 30 seconds unless given. */
  timeoutMs?: number;
  /** Waits; a test's own clock may pass at once. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Why Shopify did not answer: `credentials`, it did not take the token, or the client ID and
 * secret; `scope`, the app may not read what was asked; `store`, there is no such store, or it is
 * frozen or locked; `busy`, Shopify could not answer now; `other`, anything else.
 */
export type ShopifyFailureKind = 'credentials' | 'scope' | 'store' | 'busy' | 'other';

export type ShopifyResult<T> =
  { ok: true; value: T } | { ok: false; kind: ShopifyFailureKind; message: string };

/** What a store answers about what a query cost, as Shopify's extensions say. */
interface Cost {
  requestedQueryCost?: number;
  throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
}

interface GraphqlBody<T> {
  data?: T | null;
  errors?: { message?: string; extensions?: { code?: string } }[];
  extensions?: { cost?: Cost };
}

/** Times a throttled query is asked again before Shopify is said to be busy. */
const THROTTLE_RETRIES = 5;

/** The most a bulk query's file may hold: far more than an import takes. */
const DOWNLOAD_LIMIT = 50 * 1024 * 1024;

/**
 * A Shopify store's Admin API, through the GraphQL endpoint at its own address: a token taken once
 * from the client ID and secret where those are given, a query throttled by Shopify asked again
 * once it has the room, and Shopify's answers said as {@link ShopifyResult}s.
 */
export class ShopifyAdmin {
  readonly shop: string;
  readonly #credentials: ShopifyCredentials;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #token: string | null;

  constructor(options: ShopifyAdminOptions) {
    this.shop = options.shop;
    this.#credentials = options.credentials;
    this.#version = options.apiVersion ?? SHOPIFY_API_VERSION;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#token = 'accessToken' in options.credentials ? options.credentials.accessToken : null;
  }

  /** A query or mutation's data, asked again while Shopify throttles it. */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<ShopifyResult<T>> {
    const token = await this.#accessToken();
    if (!token.ok) return token;
    for (let attempt = 0; ; attempt++) {
      const answer = await this.#request(`/admin/api/${this.#version}/graphql.json`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': token.value,
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      if (!answer.ok) return answer;
      const response = answer.value;
      if (response.status === 429 && attempt < THROTTLE_RETRIES) {
        await this.#sleep(retryAfterMs(response.headers.get('retry-after')));
        continue;
      }
      if (!response.ok) return failureOf(response.status, this.shop);
      let body: GraphqlBody<T>;
      try {
        body = (await response.json()) as GraphqlBody<T>;
      } catch {
        return { ok: false, kind: 'other', message: 'Shopify answered with what is not JSON' };
      }
      const errors = body.errors ?? [];
      if (errors.some((error) => error.extensions?.code === 'THROTTLED')) {
        if (attempt >= THROTTLE_RETRIES) {
          return { ok: false, kind: 'busy', message: 'Shopify is limiting what the store answers' };
        }
        await this.#sleep(throttleWaitMs(body.extensions?.cost));
        continue;
      }
      if (errors.some((error) => error.extensions?.code === 'ACCESS_DENIED')) {
        return {
          ok: false,
          kind: 'scope',
          message:
            "The store's app may not read this: give it the read_products and read_inventory " +
            'access scopes',
        };
      }
      if (errors.length > 0 || body.data === undefined || body.data === null) {
        return {
          ok: false,
          kind: 'other',
          message: `Shopify said: ${errors[0]?.message ?? 'nothing'}`.slice(0, 300),
        };
      }
      return { ok: true, value: body.data };
    }
  }

  /**
   * The file a bulk query wrote, from Shopify's storage, which its link signs: https only, and
   * no larger than the most an import could use.
   */
  async download(url: string): Promise<ShopifyResult<string>> {
    let link: URL;
    try {
      link = new URL(url);
    } catch {
      return { ok: false, kind: 'other', message: "Shopify's link to the store's data is not one" };
    }
    if (link.protocol !== 'https:') {
      return {
        ok: false,
        kind: 'other',
        message: "Shopify's link to the store's data is not https",
      };
    }
    const answer = await this.#fetchWithin(link.href, { method: 'GET' });
    if (!answer.ok) return answer;
    const response = answer.value;
    if (!response.ok) {
      return {
        ok: false,
        kind: response.status >= 500 ? 'busy' : 'other',
        message: `Shopify's storage answered ${response.status}`,
      };
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > DOWNLOAD_LIMIT) {
      return { ok: false, kind: 'other', message: "The store's data is more than Hatti takes" };
    }
    const text = await response.text();
    if (text.length > DOWNLOAD_LIMIT) {
      return { ok: false, kind: 'other', message: "The store's data is more than Hatti takes" };
    }
    return { ok: true, value: text };
  }

  /** The token: the one given, or one Shopify gives for the client ID and secret. */
  async #accessToken(): Promise<ShopifyResult<string>> {
    if (this.#token !== null) return { ok: true, value: this.#token };
    const credentials = this.#credentials as { clientId: string; clientSecret: string };
    const answer = await this.#request('/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!answer.ok) return answer;
    const response = answer.value;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return {
        ok: false,
        kind: 'credentials',
        message:
          'Shopify did not take the client ID and secret: check them, and that the app is ' +
          'installed on the store',
      };
    }
    if (!response.ok) return failureOf(response.status, this.shop);
    const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    if (typeof body?.access_token !== 'string' || body.access_token === '') {
      return { ok: false, kind: 'other', message: 'Shopify gave no access token' };
    }
    this.#token = body.access_token;
    return { ok: true, value: this.#token };
  }

  #request(path: string, init: RequestInit): Promise<ShopifyResult<Response>> {
    return this.#fetchWithin(`https://${this.shop}${path}`, { ...init, redirect: 'error' });
  }

  async #fetchWithin(url: string, init: RequestInit): Promise<ShopifyResult<Response>> {
    try {
      return {
        ok: true,
        value: await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) }),
      };
    } catch {
      return { ok: false, kind: 'busy', message: 'Shopify could not be reached' };
    }
  }
}

/** What an answer that is not 2xx says. */
function failureOf(status: number, shop: string): ShopifyResult<never> {
  switch (status) {
    case 401:
      return {
        ok: false,
        kind: 'credentials',
        message: "Shopify did not take the access token: copy it again from the store's app",
      };
    case 402:
      return {
        ok: false,
        kind: 'store',
        message: 'The store is frozen: its Shopify bill is unpaid',
      };
    case 403:
      return {
        ok: false,
        kind: 'scope',
        message:
          "The store's app may not read this: give it the read_products and read_inventory " +
          'access scopes',
      };
    case 404:
      return { ok: false, kind: 'store', message: `There is no Shopify store at ${shop}` };
    case 423:
      return { ok: false, kind: 'store', message: 'Shopify has locked the store' };
    default:
      return status === 429 || status >= 500
        ? { ok: false, kind: 'busy', message: `Shopify could not answer now (${status})` }
        : { ok: false, kind: 'other', message: `Shopify answered ${status}` };
  }
}

/** How long Shopify asks to be left, in its Retry-After header's seconds; two seconds if none. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1_000 : 2_000;
}

/** How long until the store has room for the query again, from what it said it cost: 1 to 10 s. */
function throttleWaitMs(cost: Cost | undefined): number {
  const needed = (cost?.requestedQueryCost ?? 0) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
  const rate = cost?.throttleStatus?.restoreRate ?? 0;
  const seconds = rate > 0 ? Math.ceil(Math.max(needed, 0) / rate) : 2;
  return Math.min(Math.max(seconds, 1), 10) * 1_000;
}

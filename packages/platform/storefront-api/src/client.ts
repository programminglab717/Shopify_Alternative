import {
  CART_TOKEN_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_USER_AGENT_HEADER,
  cartPath,
  checkoutsPath,
  type CartActionName,
  type CartBodies,
  type CartChangeResponse,
  type CartError,
  type CartErrorResponse,
  type CartJson,
  type CartReadResponse,
  type CheckoutClient,
  type CheckoutPageResponse,
  type CheckoutStartResponse,
} from './cart.js';
import { searchPath, searchQuery, type SearchOptions, type SearchResponse } from './search.js';
import { THEME_PREVIEW_HEADER, themePreviewPath, type ThemePreviewResponse } from './theme.js';

export interface StorefrontApiOptions {
  /** Where the core answers storefronts, such as http://localhost:4000. */
  baseUrl: string;
  /** The platform's storefront key, which the core checks on every request. */
  key: string;
  /** Per request: 5 seconds unless given. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type CartActionResult =
  ({ ok: true } & CartChangeResponse) | { ok: false; error: CartError };

/** The core answered as it should not: down, misconfigured, or failing. */
export class StorefrontApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`The core's storefront API answered ${status}: ${body.slice(0, 200)}`);
    this.name = 'StorefrontApiError';
  }
}

/** Shops' carts as a storefront reaches them in the core (ADR-042). */
export class StorefrontApiClient {
  readonly #fetch: typeof fetch;

  constructor(private readonly options: StorefrontApiOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  /** The cart the shopper's `token` names; null without one, or when it names none. */
  async read(shopId: string, token: string | null): Promise<CartJson | null> {
    if (!token) return null;
    const response = await this.#request('GET', cartPath(shopId), token);
    if (response.status !== 200)
      throw new StorefrontApiError(response.status, await response.text());
    return ((await response.json()) as CartReadResponse).cart;
  }

  /** Does `action` to the cart `token` names, or to a new cart, which the answer's token names. */
  async act<A extends CartActionName>(
    shopId: string,
    token: string | null,
    action: A,
    body: CartBodies[A],
  ): Promise<CartActionResult> {
    const response = await this.#request('POST', cartPath(shopId, action), token, body);
    if (response.status === 200) {
      return { ok: true, ...((await response.json()) as CartChangeResponse) };
    }
    if (response.status === 422) {
      return { ok: false, error: ((await response.json()) as CartErrorResponse).error };
    }
    throw new StorefrontApiError(response.status, await response.text());
  }

  /**
   * Starts a checkout for the cart `token` names: where to send the shopper; EMPTY when the cart
   * has nothing that can be ordered.
   */
  async startCheckout(
    shopId: string,
    token: string | null,
  ): Promise<({ ok: true } & CheckoutStartResponse) | { ok: false; error: CartError }> {
    if (!token) return { ok: false, error: { code: 'EMPTY' } };
    const response = await this.#request('POST', checkoutsPath(shopId), token, {});
    if (response.status === 200) {
      return { ok: true, ...((await response.json()) as CheckoutStartResponse) };
    }
    if (response.status === 422) {
      return { ok: false, error: ((await response.json()) as CartErrorResponse).error };
    }
    throw new StorefrontApiError(response.status, await response.text());
  }

  /**
   * The page of the checkout `checkoutToken` names, if it is the shop's; with `form`, the fields
   * the shopper posted, which place the order, and `client`, where they posted them from.
   */
  async checkoutPage(
    shopId: string,
    checkoutToken: string,
    form: Record<string, string> | null,
    client?: CheckoutClient,
  ): Promise<CheckoutPageResponse> {
    const path = checkoutsPath(shopId, encodeURIComponent(checkoutToken));
    const from: Record<string, string> = {};
    if (client) from[CLIENT_IP_HEADER] = client.ip;
    if (client?.userAgent) from[CLIENT_USER_AGENT_HEADER] = client.userAgent;
    const response = form
      ? await this.#request('POST', path, null, form, from)
      : await this.#request('GET', path, null);
    if (response.status !== 200)
      throw new StorefrontApiError(response.status, await response.text());
    return (await response.json()) as CheckoutPageResponse;
  }

  /** The shop's active products with every word of `terms`, best first, by their IDs. */
  async search(shopId: string, terms: string, options: SearchOptions = {}): Promise<string[]> {
    const query = searchQuery(terms, options);
    const response = await this.#request('GET', `${searchPath(shopId)}?${query}`, null);
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return ((await response.json()) as SearchResponse).productIds;
  }

  /**
   * The theme a preview link's `token` shows on the shop's storefront (ADR-049), as saved now;
   * null once it shows none: expired, another shop's, or its theme deleted.
   */
  async themePreview(shopId: string, token: string): Promise<ThemePreviewResponse | null> {
    const response = await this.#request('GET', themePreviewPath(shopId), null, undefined, {
      [THEME_PREVIEW_HEADER]: token,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as ThemePreviewResponse;
  }

  #request(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...extra,
      authorization: `Bearer ${this.options.key}`,
    };
    if (token) headers[CART_TOKEN_HEADER] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.#fetch(new URL(path, this.options.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
  }
}

import {
  CART_TOKEN_HEADER,
  cartPath,
  checkoutsPath,
  type CartActionName,
  type CartBodies,
  type CartChangeResponse,
  type CartError,
  type CartErrorResponse,
  type CartJson,
  type CartReadResponse,
  type CheckoutPageResponse,
  type CheckoutStartResponse,
} from './cart.js';

export interface CartClientOptions {
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
export class CartApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`The core's cart API answered ${status}: ${body.slice(0, 200)}`);
    this.name = 'CartApiError';
  }
}

/** Shops' carts as a storefront reaches them in the core (ADR-042). */
export class CartClient {
  readonly #fetch: typeof fetch;

  constructor(private readonly options: CartClientOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  /** The cart the shopper's `token` names; null without one, or when it names none. */
  async read(shopId: string, token: string | null): Promise<CartJson | null> {
    if (!token) return null;
    const response = await this.#request('GET', cartPath(shopId), token);
    if (response.status !== 200) throw new CartApiError(response.status, await response.text());
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
    throw new CartApiError(response.status, await response.text());
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
    throw new CartApiError(response.status, await response.text());
  }

  /**
   * The page of the checkout `checkoutToken` names, if it is the shop's; with `form`, the fields
   * the shopper posted, which place the order.
   */
  async checkoutPage(
    shopId: string,
    checkoutToken: string,
    form: Record<string, string> | null,
  ): Promise<CheckoutPageResponse> {
    const path = checkoutsPath(shopId, encodeURIComponent(checkoutToken));
    const response = form
      ? await this.#request('POST', path, null, form)
      : await this.#request('GET', path, null);
    if (response.status !== 200) throw new CartApiError(response.status, await response.text());
    return (await response.json()) as CheckoutPageResponse;
  }

  #request(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.key}` };
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

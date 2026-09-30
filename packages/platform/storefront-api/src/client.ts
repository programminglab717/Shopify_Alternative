import {
  CART_TOKEN_HEADER,
  cartPath,
  type CartActionName,
  type CartBodies,
  type CartChangeResponse,
  type CartError,
  type CartErrorResponse,
  type CartJson,
  type CartReadResponse,
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

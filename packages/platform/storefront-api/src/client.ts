import {
  ACCOUNT_TOKEN_HEADER,
  accountOrderLinkPath,
  accountPath,
  accountWishlistItemPath,
  type AccountDataEraseResponse,
  type AccountDataExportResponse,
  type AccountErrorResponse,
  type AccountJson,
  type AccountLoginStartRequest,
  type AccountLoginStartResponse,
  type AccountLoginVerifyErrorResponse,
  type AccountLoginVerifyRequest,
  type AccountLoginVerifyResponse,
  type AccountOrderLinkResponse,
  type AccountResponse,
  type AccountSessionJson,
  type AccountSessionResponse,
  type AccountWishlistAddRequest,
  type AccountWishlistResponse,
} from './accounts.js';
import {
  CART_TOKEN_HEADER,
  CLIENT_BROWSER_IDS_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_PROOF_HEADER,
  CLIENT_USER_AGENT_HEADER,
  cartPath,
  checkoutsPath,
  paymentLinkPath,
  trackingPath,
  type CartActionName,
  type CartBodies,
  type CartChangeResponse,
  type CartError,
  type CartErrorResponse,
  type CartJson,
  type CartReadResponse,
  type CheckoutClient,
  type CheckoutPageResponse,
  type CheckoutStartRequest,
  type CheckoutStartResponse,
  type PaymentLinkOpenResponse,
  type TrackingPageResponse,
  type TrackingRequest,
  type StorefrontVisit,
} from './cart.js';
import {
  commentsPath,
  type CommentErrorResponse,
  type CommentRequest,
  type CommentResponse,
} from './comments.js';
import {
  contentSearchPath,
  contentSearchQuery,
  searchPath,
  searchQuery,
  type ContentSearchOptions,
  type ContentSearchResponse,
  type SearchOptions,
  type SearchResponse,
} from './search.js';
import {
  reportsPath,
  rightsComplaintsPath,
  type ReportErrorResponse,
  type ReportRequest,
  type ReportResponse,
  type RightsComplaintRequest,
} from './reports.js';
import {
  signUpsPath,
  type SignUpErrorResponse,
  type SignUpRequest,
  type SignUpResponse,
} from './sign-ups.js';
import {
  stockWatchesPath,
  type StockWatchErrorResponse,
  type StockWatchRequest,
  type StockWatchResponse,
} from './stock-watches.js';
import {
  THEME_PREVIEW_HEADER,
  themeImagePath,
  themePreviewPath,
  type ThemeImage,
  type ThemePreviewResponse,
} from './theme.js';

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

export type SignUpResult = ({ ok: true } & SignUpResponse) | ({ ok: false } & SignUpErrorResponse);
export type ReportResult = ({ ok: true } & ReportResponse) | ({ ok: false } & ReportErrorResponse);

export type StockWatchResult =
  ({ ok: true } & StockWatchResponse) | ({ ok: false } & StockWatchErrorResponse);

export type CommentResult =
  ({ ok: true } & CommentResponse) | ({ ok: false } & CommentErrorResponse);

export type AccountLoginStartResult =
  ({ ok: true } & AccountLoginStartResponse) | ({ ok: false } & AccountErrorResponse);

export type AccountLoginVerifyResult =
  ({ ok: true } & AccountLoginVerifyResponse) | ({ ok: false } & AccountLoginVerifyErrorResponse);

/** Where a shopper signs in from, as their browser told the storefront: its internet address. */
export interface AccountClient {
  ip: string;
}

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
   * has nothing that can be ordered. `visits`, the first and the last, are those that brought the
   * shopper, for the order to keep (ADR-139).
   */
  async startCheckout(
    shopId: string,
    token: string | null,
    visits: StorefrontVisit[] = [],
  ): Promise<({ ok: true } & CheckoutStartResponse) | { ok: false; error: CartError }> {
    if (!token) return { ok: false, error: { code: 'EMPTY' } };
    const body: CheckoutStartRequest = visits.length > 0 ? { visits } : {};
    const response = await this.#request('POST', checkoutsPath(shopId), token, body);
    if (response.status === 200) {
      return { ok: true, ...((await response.json()) as CheckoutStartResponse) };
    }
    if (response.status === 422) {
      return { ok: false, error: ((await response.json()) as CartErrorResponse).error };
    }
    throw new StorefrontApiError(response.status, await response.text());
  }

  /**
   * Opens the shop's payment link `token` (ADR-248) for a shopper whom `visits` brought: where to
   * send them, a checkout of their own; or the page saying why not, to send as it is.
   */
  async openPaymentLink(
    shopId: string,
    token: string,
    visits: StorefrontVisit[] = [],
  ): Promise<PaymentLinkOpenResponse> {
    const body: CheckoutStartRequest = visits.length > 0 ? { visits } : {};
    const path = paymentLinkPath(shopId, encodeURIComponent(token));
    const response = await this.#request('POST', path, null, body);
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as PaymentLinkOpenResponse;
  }

  /**
   * The shop's tracking page (ADR-251): its form, or, with `form`, the order what the shopper
   * typed finds.
   */
  async trackingPage(shopId: string, form: TrackingRequest | null): Promise<TrackingPageResponse> {
    const response = form
      ? await this.#request('POST', trackingPath(shopId), null, form)
      : await this.#request('GET', trackingPath(shopId), null);
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as TrackingPageResponse;
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
    const ids = Object.entries(client?.browserIds ?? {}).filter(([, value]) => value);
    if (ids.length > 0) from[CLIENT_BROWSER_IDS_HEADER] = new URLSearchParams(ids).toString();
    if (client?.proof) from[CLIENT_PROOF_HEADER] = client.proof;
    const response = form
      ? await this.#request('POST', path, null, form, from)
      : await this.#request('GET', path, null);
    if (response.status !== 200)
      throw new StorefrontApiError(response.status, await response.text());
    return (await response.json()) as CheckoutPageResponse;
  }

  /**
   * The name and number a shopper typed on the checkout `checkoutToken` names, as its page's
   * script sends them (ADR-393): kept for the shop, nothing answered.
   */
  async checkoutContact(
    shopId: string,
    checkoutToken: string,
    contact: { name: string; phone: string },
  ): Promise<void> {
    const path = `${checkoutsPath(shopId, encodeURIComponent(checkoutToken))}/contact`;
    const response = await this.#request('POST', path, null, contact);
    if (response.status !== 204) {
      throw new StorefrontApiError(response.status, await response.text());
    }
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

  /** The shop's published articles and pages with every word of `terms`, best first (ADR-212). */
  async searchContent(
    shopId: string,
    terms: string,
    options: ContentSearchOptions = {},
  ): Promise<ContentSearchResponse> {
    const query = contentSearchQuery(terms, options);
    const response = await this.#request('GET', `${contentSearchPath(shopId)}?${query}`, null);
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as ContentSearchResponse;
  }

  /**
   * A shopper's comment on an article, through its page's form (ADR-220): shown at once or
   * waiting for the shop's approval, or what was wrong with it.
   */
  async postComment(shopId: string, request: CommentRequest): Promise<CommentResult> {
    const response = await this.#request('POST', commentsPath(shopId), null, request);
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as CommentErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as CommentResponse) };
  }

  /**
   * A shopper's sign-up through the shop's form (ADR-189): what the core made of it, or what was
   * wrong with it.
   */
  async signUp(shopId: string, request: SignUpRequest): Promise<SignUpResult> {
    const response = await this.#request('POST', signUpsPath(shopId), null, request);
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as SignUpErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as SignUpResponse) };
  }

  /** A shopper's report of the store (ADR-460): its number, or what was wrong with it. */
  async report(shopId: string, request: ReportRequest): Promise<ReportResult> {
    const response = await this.#request('POST', reportsPath(shopId), null, request);
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as ReportErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as ReportResponse) };
  }

  /**
   * A rights owner's complaint of listings on the store (TNS-04, ADR-474): its number, or what was
   * wrong with it.
   */
  async complainOfRights(shopId: string, request: RightsComplaintRequest): Promise<ReportResult> {
    const response = await this.#request('POST', rightsComplaintsPath(shopId), null, request);
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as ReportErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as ReportResponse) };
  }

  /**
   * A shopper's wish to hear when a sold-out variant is back (ADR-429): what the core made of it,
   * or what was wrong with it.
   */
  async watchStock(shopId: string, request: StockWatchRequest): Promise<StockWatchResult> {
    const response = await this.#request('POST', stockWatchesPath(shopId), null, request);
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as StockWatchErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as StockWatchResponse) };
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

  /**
   * A picture of the shop's that one of its themes shows (ADR-326), or, for a page in a preview,
   * any of its pictures; null when there is none to show. At `width`, in the best format the
   * browser's `accept` names, where they are given (ADR-538).
   */
  async themeImage(
    shopId: string,
    fileId: string,
    preview: boolean,
    asked: { width?: number | null; accept?: string } = {},
  ): Promise<ThemeImage | null> {
    const response = await this.#request(
      'GET',
      themeImagePath(shopId, fileId, preview, asked.width ?? null),
      null,
      undefined,
      asked.accept ? { accept: asked.accept } : {},
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * Sends a code to sign in with to the number a shopper typed (CUS-02, ADR-570), from the
   * address `client` gives: whether it went, the same for any number; or what was wrong with it.
   */
  async accountLoginStart(
    shopId: string,
    request: AccountLoginStartRequest,
    client?: AccountClient,
  ): Promise<AccountLoginStartResult> {
    const response = await this.#request(
      'POST',
      accountPath(shopId, 'login'),
      null,
      request,
      client ? { [CLIENT_IP_HEADER]: client.ip } : {},
    );
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as AccountErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as AccountLoginStartResponse) };
  }

  /**
   * Checks the code the shopper typed (ADR-570): signed in, with the session's secret for the
   * browser's cookie, which the core gives only now; or why not.
   */
  async accountLoginVerify(
    shopId: string,
    request: AccountLoginVerifyRequest,
  ): Promise<AccountLoginVerifyResult> {
    const response = await this.#request(
      'POST',
      accountPath(shopId, 'login/verify'),
      null,
      request,
    );
    if (response.status === 422) {
      return { ok: false, ...((await response.json()) as AccountLoginVerifyErrorResponse) };
    }
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return { ok: true, ...((await response.json()) as AccountLoginVerifyResponse) };
  }

  /**
   * The session the cookie's `token` names, which reading keeps going (ADR-570); null without
   * one, and once it is none: signed out, expired or unknown.
   */
  async accountSession(shopId: string, token: string | null): Promise<AccountSessionJson | null> {
    if (!token) return null;
    const response = await this.#request('GET', accountPath(shopId, 'session'), null, undefined, {
      [ACCOUNT_TOKEN_HEADER]: token,
    });
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return ((await response.json()) as AccountSessionResponse).session;
  }

  /** Signs the session the cookie's `token` names out (ADR-570); nothing to do without one. */
  async accountLogout(shopId: string, token: string | null): Promise<void> {
    if (!token) return;
    const response = await this.#request(
      'POST',
      accountPath(shopId, 'logout'),
      null,
      {},
      {
        [ACCOUNT_TOKEN_HEADER]: token,
      },
    );
    if (response.status !== 204) {
      throw new StorefrontApiError(response.status, await response.text());
    }
  }

  /**
   * The account of the session the cookie's `token` names (ADR-570): the shopper's orders with the
   * shop and their store credit; null without a session.
   */
  async account(shopId: string, token: string | null): Promise<AccountJson | null> {
    if (!token) return null;
    const response = await this.#request('GET', accountPath(shopId), null, undefined, {
      [ACCOUNT_TOKEN_HEADER]: token,
    });
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return ((await response.json()) as AccountResponse).account;
  }

  /**
   * The page of the order `orderId` of the account the cookie's `token` names, its public ID from
   * {@link account} (ADR-570): where to send the shopper; null without a session, for an order not
   * theirs, or one with no page.
   */
  async accountOrderLink(
    shopId: string,
    token: string | null,
    orderId: string,
  ): Promise<AccountOrderLinkResponse | null> {
    if (!token) return null;
    const path = accountOrderLinkPath(shopId, encodeURIComponent(orderId));
    const response = await this.#request('POST', path, null, {}, { [ACCOUNT_TOKEN_HEADER]: token });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as AccountOrderLinkResponse;
  }

  /**
   * Makes the file of the shopper's own data, of the account the cookie's `token` names, or gives
   * the one kept for the day (ADR-572): a link that downloads it for a few minutes; or `none`, as
   * the shop keeps nothing of them. Null without a session.
   */
  async accountDataExport(
    shopId: string,
    token: string | null,
  ): Promise<AccountDataExportResponse | null> {
    if (!token) return null;
    const response = await this.#request(
      'POST',
      accountPath(shopId, 'data/export'),
      null,
      {},
      {
        [ACCOUNT_TOKEN_HEADER]: token,
      },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as AccountDataExportResponse;
  }

  /**
   * A new link to the file kept of the shopper's own data (ADR-572), which downloads it for a few
   * minutes; null without a session, or a file kept.
   */
  async accountDataExportLink(
    shopId: string,
    token: string | null,
  ): Promise<Exclude<AccountDataExportResponse, { state: 'none' }> | null> {
    if (!token) return null;
    const response = await this.#request(
      'GET',
      accountPath(shopId, 'data/export'),
      null,
      undefined,
      { [ACCOUNT_TOKEN_HEADER]: token },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as Exclude<AccountDataExportResponse, { state: 'none' }>;
  }

  /**
   * Asks for the erasure of the shopper whose account the cookie's `token` names (ADR-572), as
   * the shop's staff would for them: how it waits; or `none`, as the shop keeps nothing of them.
   * Null without a session.
   */
  async accountDataErase(
    shopId: string,
    token: string | null,
  ): Promise<AccountDataEraseResponse | null> {
    if (!token) return null;
    const response = await this.#request(
      'POST',
      accountPath(shopId, 'data/erase'),
      null,
      {},
      {
        [ACCOUNT_TOKEN_HEADER]: token,
      },
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return (await response.json()) as AccountDataEraseResponse;
  }

  /**
   * The wishlist of the account the cookie's `token` names (ADR-575): its products, the newest
   * first, by the catalog's IDs; null without a session.
   */
  async accountWishlist(shopId: string, token: string | null): Promise<string[] | null> {
    if (!token) return null;
    return this.#wishlist(
      await this.#request('GET', accountPath(shopId, 'wishlist'), null, undefined, {
        [ACCOUNT_TOKEN_HEADER]: token,
      }),
    );
  }

  /**
   * Adds `productIds`, the newest first, to the wishlist of the account the cookie's `token` names
   * (ADR-575), as a browser's own list joins it on signing in: the wishlist as it is now; null
   * without a session.
   */
  async accountWishlistAdd(
    shopId: string,
    token: string | null,
    productIds: readonly string[],
  ): Promise<string[] | null> {
    if (!token) return null;
    const body: AccountWishlistAddRequest = { productIds: [...productIds] };
    return this.#wishlist(
      await this.#request('POST', accountPath(shopId, 'wishlist'), null, body, {
        [ACCOUNT_TOKEN_HEADER]: token,
      }),
    );
  }

  /**
   * Takes the product `productId` off the wishlist of the account the cookie's `token` names
   * (ADR-575): the wishlist as it is now; null without a session.
   */
  async accountWishlistRemove(
    shopId: string,
    token: string | null,
    productId: string,
  ): Promise<string[] | null> {
    if (!token) return null;
    const path = accountWishlistItemPath(shopId, encodeURIComponent(productId));
    return this.#wishlist(
      await this.#request('DELETE', path, null, undefined, { [ACCOUNT_TOKEN_HEADER]: token }),
    );
  }

  /** A wishlist's answer: its products; null without a session. */
  async #wishlist(response: Response): Promise<string[] | null> {
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new StorefrontApiError(response.status, await response.text());
    }
    return ((await response.json()) as AccountWishlistResponse).productIds;
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

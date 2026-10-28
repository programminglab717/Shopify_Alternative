import { createHmac } from 'node:crypto';

// Daraz's Open Platform (CH-06, ADR-875), as its seller API answers: the protocol of Lazada's
// Open Platform, which Daraz shares. Each call names the app by its key, the time, and a signature:
// HMAC-SHA256 under the app's secret of the API's path followed by every parameter, sorted by
// name, each name then its value, in upper-case hex. A seller's calls carry the access token the
// seller's authorisation was exchanged for; tokens are refreshed before they end.

export interface DarazSettings {
  appKey: string;
  appSecret: string;
  /** The seller API: https://api.daraz.pk/rest. */
  apiUrl: string;
  /** Where codes are exchanged for tokens: https://auth.daraz.com/rest. */
  authUrl: string;
  /** Where a seller authorises the app: https://api.daraz.pk/oauth/authorize. */
  authorizeUrl: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
}

/** A seller's tokens, as Daraz gives them. */
export interface DarazTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  /** The seller's account, as Daraz names it: their email or shop name. */
  account: string;
  sellerId: string | null;
}

/** An order as Daraz lists it. */
export interface DarazOrder {
  orderId: string;
  status: string;
  createdAt: string;
  address: {
    name: string;
    phone: string;
    address1: string;
    address2: string | null;
    city: string;
  };
}

/** One unit of an order, as Daraz lists its items: one a unit. */
export interface DarazOrderItem {
  orderId: string;
  sku: string;
  name: string;
  /** What the buyer paid for it, in rupees as Daraz gives it: "1500.00". */
  paidPrice: string;
}

/** A SKU's stock and price for Daraz to take. */
export interface DarazSkuUpdate {
  sku: string;
  quantity: number;
  /** In rupees, "1500.00"; left out where prices are the shop's to keep on Daraz. */
  price?: string;
}

export class DarazError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** SKUs Daraz refused, where it said which. */
    readonly detail: { sku: string; error: string }[] | null = null,
  ) {
    super(message);
    this.name = 'DarazError';
  }
}

/** The signature of a call to `path` with `params`, as the Open Platform checks it. */
export function darazSignature(
  secret: string,
  path: string,
  params: Readonly<Record<string, string>>,
): string {
  const text =
    path +
    Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join('');
  return createHmac('sha256', secret).update(text, 'utf8').digest('hex').toUpperCase();
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The payload Daraz takes for SKUs' stock and prices. */
export function priceQuantityPayload(updates: readonly DarazSkuUpdate[]): string {
  const skus = updates
    .map(
      (update) =>
        `<Sku><SellerSku>${escapeXml(update.sku)}</SellerSku><Quantity>${update.quantity}</Quantity>` +
        (update.price === undefined ? '' : `<Price>${escapeXml(update.price)}</Price>`) +
        '</Sku>',
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" ?><Request><Product><Skus>${skus}</Skus></Product></Request>`;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

export class DarazClient {
  readonly #fetch: typeof globalThis.fetch;

  constructor(readonly settings: DarazSettings) {
    this.#fetch = settings.fetch ?? fetch;
  }

  /** Where a seller is sent to authorise Hatti, coming back to `redirectUri` with a code. */
  authorizeUrl(redirectUri: string, state: string): string {
    const query = new URLSearchParams({
      response_type: 'code',
      force_auth: 'true',
      redirect_uri: redirectUri,
      client_id: this.settings.appKey,
      state,
    });
    return `${this.settings.authorizeUrl}?${query}`;
  }

  /** A seller's authorisation `code` exchanged for their tokens. */
  async createToken(code: string, now: Date = new Date()): Promise<DarazTokens> {
    return this.#tokens(
      await this.#call(this.settings.authUrl, '/auth/token/create', { code }, null, 'POST'),
      now,
    );
  }

  /** A seller's tokens renewed before the access token ends. */
  async refreshToken(refreshToken: string, now: Date = new Date()): Promise<DarazTokens> {
    return this.#tokens(
      await this.#call(
        this.settings.authUrl,
        '/auth/token/refresh',
        { refresh_token: refreshToken },
        null,
        'POST',
      ),
      now,
    );
  }

  /** The seller's orders changed since `after`, a page of up to 100 from `offset`. */
  async orders(accessToken: string, after: Date, offset = 0): Promise<DarazOrder[]> {
    const body = await this.#call(
      this.settings.apiUrl,
      '/orders/get',
      {
        update_after: after.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        sort_by: 'updated_at',
        sort_direction: 'ASC',
        limit: '100',
        offset: String(offset),
      },
      accessToken,
    );
    const orders = ((body.data as { orders?: unknown[] } | undefined)?.orders ?? []) as Record<
      string,
      unknown
    >[];
    return orders.map((order) => {
      const address = (order.address_shipping ?? {}) as Record<string, unknown>;
      const statuses = Array.isArray(order.statuses) ? order.statuses : [];
      return {
        orderId: text(order.order_id),
        status: text(statuses[0]) || text(order.status),
        createdAt: text(order.created_at),
        address: {
          name: [text(address.first_name), text(address.last_name)].filter(Boolean).join(' '),
          phone: text(address.phone),
          address1: text(address.address1),
          address2: text(address.address2) || null,
          city: text(address.city) || text(address.address3),
        },
      };
    });
  }

  /** The items of `orderIds`, a unit each. */
  async orderItems(accessToken: string, orderIds: readonly string[]): Promise<DarazOrderItem[]> {
    if (orderIds.length === 0) return [];
    const body = await this.#call(
      this.settings.apiUrl,
      '/orders/items/get',
      { order_ids: `[${orderIds.join(',')}]` },
      accessToken,
    );
    const orders = (Array.isArray(body.data) ? body.data : []) as Record<string, unknown>[];
    return orders.flatMap((order) =>
      (
        (Array.isArray(order.order_items) ? order.order_items : []) as Record<string, unknown>[]
      ).map((item) => ({
        orderId: text(order.order_id) || text(item.order_id),
        sku: text(item.sku),
        name: text(item.name),
        paidPrice: text(item.paid_price) || text(item.item_price),
      })),
    );
  }

  /** SKUs' stock and prices, as Daraz takes them: the SKUs it refused, with why. */
  async updatePriceQuantity(
    accessToken: string,
    updates: readonly DarazSkuUpdate[],
  ): Promise<{ sku: string; error: string }[]> {
    if (updates.length === 0) return [];
    try {
      await this.#call(
        this.settings.apiUrl,
        '/product/price_quantity/update',
        { payload: priceQuantityPayload(updates) },
        accessToken,
        'POST',
      );
      return [];
    } catch (error) {
      if (!(error instanceof DarazError) || !error.detail) throw error;
      return error.detail;
    }
  }

  async #call(
    base: string,
    path: string,
    params: Record<string, string>,
    accessToken: string | null,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<Record<string, unknown>> {
    const all: Record<string, string> = {
      ...params,
      app_key: this.settings.appKey,
      timestamp: String(Date.now()),
      sign_method: 'sha256',
      ...(accessToken && { access_token: accessToken }),
    };
    all.sign = darazSignature(this.settings.appSecret, path, all);
    const query = new URLSearchParams(all);
    const url = `${base.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response =
        method === 'GET'
          ? await this.#fetch(`${url}?${query}`, {
              signal: AbortSignal.timeout(this.settings.timeoutMs ?? 20_000),
            })
          : await this.#fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
              body: query.toString(),
              signal: AbortSignal.timeout(this.settings.timeoutMs ?? 20_000),
            });
    } catch (error) {
      throw new DarazError('unreachable', `Daraz not reached: ${String(error)}`.slice(0, 300));
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const code = text(body.code);
    if (!response.ok || (code !== '' && code !== '0')) {
      const detail = Array.isArray(body.detail)
        ? (body.detail as Record<string, unknown>[]).map((each) => ({
            sku: text(each.seller_sku),
            error: text(each.message),
          }))
        : null;
      throw new DarazError(
        code || String(response.status),
        text(body.message) || 'Daraz refused it',
        detail,
      );
    }
    return body;
  }

  #tokens(body: Record<string, unknown>, now: Date): DarazTokens {
    const accessToken = text(body.access_token);
    const refreshToken = text(body.refresh_token);
    if (!accessToken || !refreshToken) throw new DarazError('invalid', 'Daraz gave no tokens');
    const seconds = (value: unknown, fallback: number) =>
      typeof value === 'number' && value > 0 ? value : fallback;
    const user = (
      Array.isArray(body.country_user_info) ? body.country_user_info[0] : null
    ) as Record<string, unknown> | null;
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(now.getTime() + seconds(body.expires_in, 86_400) * 1000),
      refreshExpiresAt: new Date(
        now.getTime() + seconds(body.refresh_expires_in, 2_592_000) * 1000,
      ),
      account: text(body.account) || 'Daraz seller',
      sellerId: text(user?.seller_id) || null,
    };
  }
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fromMajor, isCurrencyCode, money, toMajorString, type CurrencyCode } from '@hatti/money';

// Payment gateways' APIs behind one interface (PAY-01, ADR-151): starting a checkout for an
// amount, and reading what the gateway says of it when the customer comes back from it and in
// its webhooks; and giving a payment back, where the gateway's API does (PAY-06, ADR-153). Shops
// connect their own accounts, so each call carries the account's credentials, and the money goes
// to the shop, never through Hatti (ADR-009).

/** A gateway's test environment, whose payments move no money, or the real one. */
export const GATEWAY_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type GatewayEnvironmentValue = (typeof GATEWAY_ENVIRONMENTS)[number];

/** A credential a gateway's API asks for, as staff copy it from the gateway's dashboard. */
export interface GatewayCredentialField {
  key: string;
  label: string;
}

/**
 * What of a payment a gateway's adapter gives back through its API (ADR-153): nothing, the whole
 * payment alone, or any part of it.
 */
export const GATEWAY_REFUNDS = ['none', 'whole', 'partial'] as const;
export type GatewayRefundsValue = (typeof GATEWAY_REFUNDS)[number];

/** A gateway shops take payments through: its key, its name, and what connecting asks for. */
export interface PaymentGatewayInfo {
  /** "safepay". */
  gateway: string;
  /** "Safepay", as the customer's page names it. */
  name: string;
  credentials: readonly GatewayCredentialField[];
  /** The currencies it takes. */
  currencies: readonly CurrencyCode[];
  /** Takes nothing from anyone: for development and tests, never in production. */
  test: boolean;
  /** What of a payment it gives back through its API; with `none`, {@link PaymentGateway.refund} is absent. */
  refunds: GatewayRefundsValue;
}

/** An account's credentials, opened, by {@link GatewayCredentialField.key}. */
export type GatewayCredentials = Readonly<Record<string, string>>;

/** The account a call is made with. */
export interface GatewayAccount {
  credentials: GatewayCredentials;
  environment: GatewayEnvironmentValue;
}

/** A checkout to start: what to take, for which order, and where the customer goes after. */
export interface GatewayCheckoutRequest {
  /** Minor units. */
  amount: bigint;
  currency: CurrencyCode;
  /** The order's name, "#1043": the gateway's reference for it. */
  orderName: string;
  /** Where the customer comes back once they paid. */
  returnUrl: string;
  /** Where the customer goes if they give up. */
  cancelUrl: string;
}

/** A checkout the gateway started. */
export interface GatewayCheckout {
  /** The gateway's name for the payment, such as Safepay's tracker. */
  ref: string;
  /** The gateway's page to send the customer to. */
  url: string;
}

/** A payment the gateway vouches for, signed with the account's secret. */
export interface GatewayPayment {
  /** The gateway's name for it, as {@link GatewayCheckout.ref}. */
  ref: string;
  /** Minor units; null when the gateway does not say, as on Safepay's return. */
  amount: bigint | null;
  /** The amount's currency, as the gateway says it. */
  currency: string | null;
  /** The gateway's reference for the payment, to find it by in its dashboard. */
  reference: string | null;
}

/** What a gateway answered: what was asked, or why not, and whether trying again may help. */
export type GatewayResult<T> =
  { ok: true; value: T } | { ok: false; retry: boolean; message: string };

/** A payment to give back, wholly or in part. */
export interface GatewayRefundRequest {
  /** The gateway's name for the payment, as {@link GatewayCheckout.ref}. */
  ref: string;
  /** Minor units: what to give back. */
  amount: bigint;
  currency: CurrencyCode;
}

/**
 * What a gateway answered a refund with: given back, with its reference for it; or not, and
 * whether it may have been all the same (`unknown`), as when no answer came.
 */
export type GatewayRefundResult =
  { ok: true; reference: string | null } | { ok: false; unknown: boolean; message: string };

/** A request to a gateway's webhook, as it came. */
export interface GatewayWebhook {
  /** The body as sent, which signatures cover. */
  body: Buffer;
  /** Header names in lower case. */
  headers: Readonly<Record<string, string | undefined>>;
}

/** A gateway's API (docs/architecture/05-checkout-and-payments.md). */
export interface PaymentGateway {
  readonly info: PaymentGatewayInfo;
  /**
   * Where its checkout pages are in `environment`, by origin, which pages sending customers there
   * let their forms go on to; null when they are the pages' own addresses.
   */
  checkoutOrigin(environment: GatewayEnvironmentValue): string | null;
  /** Starts a checkout: the gateway's name for it, and its page to send the customer to. */
  checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>>;
  /**
   * The customer came back from the gateway's page with `form`, as the gateway sent them: the
   * payment it vouches for, if signed with the account's secret; null otherwise.
   */
  returned(account: GatewayAccount, form: Readonly<Record<string, string>>): GatewayPayment | null;
  /**
   * What a request to the webhook says: a payment made, if signed with the account's secret;
   * `unsigned` if the signature does not hold; null if it says nothing of a payment made.
   */
  webhook(account: GatewayAccount, request: GatewayWebhook): GatewayPayment | 'unsigned' | null;
  /**
   * Gives back what `request` names of a payment made through the account, as far as
   * {@link PaymentGatewayInfo.refunds} says it can; absent when it can give nothing back.
   */
  refund?(account: GatewayAccount, request: GatewayRefundRequest): Promise<GatewayRefundResult>;
}

/** The gateways shops can take payments through, by key. */
export class PaymentGateways {
  readonly #gateways: ReadonlyMap<string, PaymentGateway>;

  constructor(gateways: readonly PaymentGateway[]) {
    this.#gateways = new Map(gateways.map((gateway) => [gateway.info.gateway, gateway]));
  }

  /** The gateway `gateway`'s adapter; null if shops cannot take payments through it here. */
  of(gateway: string): PaymentGateway | null {
    return this.#gateways.get(gateway) ?? null;
  }

  /** What each gateway is and asks for, by name. */
  get list(): PaymentGatewayInfo[] {
    return [...this.#gateways.values()]
      .map((gateway) => gateway.info)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Where Safepay's API and checkout answer, in each of its environments. */
export interface SafepayUrls {
  api: string;
  checkout: string;
}

export const SAFEPAY_URLS: Readonly<Record<GatewayEnvironmentValue, SafepayUrls>> = {
  sandbox: {
    api: 'https://sandbox.api.getsafepay.com',
    checkout: 'https://sandbox.api.getsafepay.com/checkout',
  },
  production: {
    api: 'https://api.getsafepay.com',
    checkout: 'https://getsafepay.com/checkout',
  },
};

export interface SafepayOptions {
  /** {@link SAFEPAY_URLS}, unless a test says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, SafepayUrls>>;
  /** How long a request may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/** What Safepay answers a new tracker, or a refund, with. */
interface SafepayAnswer {
  data?: { token?: unknown; state?: unknown } | null;
  status?: { message?: unknown; errors?: unknown } | null;
}

/**
 * Safepay (https://getsafepay.com), as its SDKs drive it: a tracker for the amount, then its
 * checkout page, which sends the customer back with the tracker signed with the account's secret
 * key; and a webhook signed with its webhook secret, which says the tracker is paid and how much.
 * It gives a tracker's payment back whole, as its SDKs ask for a refund (ADR-153).
 */
export class SafepayGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'safepay',
    name: 'Safepay',
    credentials: [
      { key: 'apiKey', label: 'API key' },
      { key: 'secretKey', label: 'Secret key' },
      { key: 'webhookSecret', label: 'Webhook secret' },
    ],
    currencies: ['PKR', 'USD'],
    test: false,
    refunds: 'whole',
  };

  constructor(private readonly options: SafepayOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#urls(environment).checkout).origin;
  }

  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    const urls = this.#urls(account.environment);
    let response: Response;
    try {
      response = await fetch(`${urls.api}/order/v1/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          // In rupees, as Safepay takes it: 2500.5 for Rs 2,500.50.
          amount: Number(toMajorString(money(request.amount, request.currency))),
          client: account.credentials.apiKey ?? '',
          currency: request.currency,
          environment: account.environment,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `Safepay could not be reached: ${(error as Error).message}`.slice(0, 1_000),
      };
    }
    const json = (await response.json().catch(() => null)) as SafepayAnswer | null;
    const token = json?.data?.token;
    if (!response.ok || typeof token !== 'string' || !/^[\w-]{1,200}$/.test(token)) {
      const errors = Array.isArray(json?.status?.errors)
        ? json.status.errors.filter((each): each is string => typeof each === 'string')
        : [];
      const said =
        errors.join('; ') || (typeof json?.status?.message === 'string' ? json.status.message : '');
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `Safepay: ${said.trim() || `it answered ${response.status}`}`.slice(0, 1_000),
      };
    }
    const params = new URLSearchParams({
      beacon: token,
      cancel_url: request.cancelUrl,
      env: account.environment,
      order_id: request.orderName,
      redirect_url: request.returnUrl,
      source: 'custom',
      // Safepay's page sends the customer back signed, as webhooks are.
      webhooks: 'true',
    });
    return { ok: true, value: { ref: token, url: `${urls.checkout}/pay?${params}` } };
  }

  /**
   * Gives the tracker's payment back, as Safepay's SDKs ask for a refund: its v3 API, with the
   * account's secret key, the amount in the currency's smallest unit as that API takes amounts.
   * Asked only for a whole payment, so that however Safepay reads the amount, it gives back the
   * payment or refuses. A 4xx is a refusal; no answer, or a 5xx, may have given it back all the
   * same.
   */
  async refund(
    account: GatewayAccount,
    request: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    const urls = this.#urls(account.environment);
    let response: Response;
    try {
      response = await fetch(
        `${urls.api}/order/payments/v3/${encodeURIComponent(request.ref)}/refund`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-sfpy-merchant-secret': account.credentials.secretKey ?? '',
          },
          body: JSON.stringify({ amount: Number(request.amount) }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        },
      );
    } catch (error) {
      // Not reached at all: it gave nothing back. Anything else, such as no answer in time, may
      // have reached it all the same.
      const reached = !notConnected(error);
      return {
        ok: false,
        unknown: reached,
        message: (reached
          ? `Safepay did not answer: ${(error as Error).message}`
          : `Safepay could not be reached: ${(error as Error).message}`
        ).slice(0, 1_000),
      };
    }
    const json = (await response.json().catch(() => null)) as SafepayAnswer | null;
    if (!response.ok) {
      const errors = Array.isArray(json?.status?.errors)
        ? json.status.errors.filter((each): each is string => typeof each === 'string')
        : [];
      const said =
        errors.join('; ') || (typeof json?.status?.message === 'string' ? json.status.message : '');
      return {
        ok: false,
        unknown: response.status >= 500,
        message: `Safepay: ${said.trim() || `it answered ${response.status}`}`.slice(0, 1_000),
      };
    }
    const token = json?.data?.token;
    return {
      ok: true,
      reference: typeof token === 'string' && /^[\w-]{1,200}$/.test(token) ? token : null,
    };
  }

  /** Safepay sends the customer back with the tracker, signed: HMAC-SHA256 with the secret key. */
  returned(account: GatewayAccount, form: Readonly<Record<string, string>>): GatewayPayment | null {
    const { tracker, sig, reference } = form;
    const secret = account.credentials.secretKey;
    if (!tracker || !sig || !secret) return null;
    const expected = createHmac('sha256', secret).update(tracker).digest('hex');
    if (!sameHex(sig, expected)) return null;
    return {
      ref: tracker,
      amount: null,
      currency: null,
      reference: reference?.trim().slice(0, 200) || null,
    };
  }

  /**
   * Safepay signs each webhook with the webhook secret: HMAC-SHA512 of its body, in
   * X-SFPY-SIGNATURE. Its SDKs have signed the body as sent, and its `data` alone, as JSON: either
   * holds. A notification that the tracker's payment is PAID says so, with the amount in rupees.
   */
  webhook(account: GatewayAccount, request: GatewayWebhook): GatewayPayment | 'unsigned' | null {
    const signature = request.headers['x-sfpy-signature'];
    const secret = account.credentials.webhookSecret;
    if (!signature || !secret) return 'unsigned';
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString('utf8'));
    } catch {
      return 'unsigned';
    }
    const sign = (bytes: Buffer | string) =>
      createHmac('sha512', secret).update(bytes).digest('hex');
    const data = isObject(body) && isObject(body.data) ? body.data : null;
    const signed =
      sameHex(signature, sign(request.body)) ||
      (data !== null && sameHex(signature, sign(JSON.stringify(data))));
    if (!signed) return 'unsigned';
    const event = data ?? body;
    if (!isObject(event)) return null;
    const type = typeof event.type === 'string' ? event.type : '';
    const notification = isObject(event.notification) ? event.notification : null;
    if (!notification || /refund/i.test(type) || notification.state !== 'PAID') return null;
    const tracker = notification.tracker;
    if (typeof tracker !== 'string' || tracker === '') return null;
    const currency = notification.currency;
    let amount: bigint | null = null;
    if (typeof currency === 'string' && isCurrencyCode(currency)) {
      try {
        amount = fromMajor(String(notification.amount), currency).amount;
      } catch {
        amount = null;
      }
    }
    const reference = notification.reference;
    return {
      ref: tracker,
      amount: amount !== null && amount > 0n ? amount : null,
      currency: amount !== null && amount > 0n ? (currency as string) : null,
      reference:
        typeof reference === 'string' || typeof reference === 'number'
          ? String(reference).slice(0, 200)
          : null,
    };
  }

  #urls(environment: GatewayEnvironmentValue): SafepayUrls {
    const urls = this.options.urls?.[environment] ?? SAFEPAY_URLS[environment];
    return { api: urls.api.replace(/\/+$/, ''), checkout: urls.checkout.replace(/\/+$/, '') };
  }
}

/**
 * A gateway that takes nothing (ADR-151): for trying payments out in development and tests. Its
 * checkout page is the return address itself, signed as {@link TestGateway.returnForm} signs it,
 * as if the customer had paid; its webhooks are signed as {@link TestGateway.webhookFor} signs
 * them. It runs in this process alone.
 */
export class TestGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'test',
    name: 'Test gateway',
    credentials: [{ key: 'secret', label: 'Any secret' }],
    currencies: ['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR', 'CAD'],
    test: true,
    refunds: 'partial',
  };

  /** What it was asked to take, the latest last. */
  readonly checkouts: (GatewayCheckoutRequest & { ref: string })[] = [];
  /** Answers checkouts with this, when set, as a gateway refusing them would. */
  refusing: string | null = null;
  /** What it gave back, the latest last. */
  readonly refunds: (GatewayRefundRequest & { reference: string })[] = [];
  /**
   * Answers refunds with this, when set: refusing them, or not answering, as a gateway that took
   * too long would.
   */
  refundAnswer: { refuse: string } | 'silent' | null = null;
  /** Runs while a refund is being given, as when staff act meanwhile. */
  whileRefunding: (() => Promise<void>) | null = null;

  /** Its page is the return address, on the shop's own pages. */
  checkoutOrigin(): null {
    return null;
  }

  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (this.refusing) return { ok: false, retry: false, message: this.refusing };
    const ref = `test_${randomBytes(9).toString('hex')}`;
    this.checkouts.push({ ...request, ref });
    const form = this.returnForm(account, ref);
    const url = new URL(request.returnUrl);
    for (const [name, value] of Object.entries(form)) url.searchParams.set(name, value);
    return { ok: true, value: { ref, url: url.toString() } };
  }

  /** The form the gateway sends the customer back with, once they paid `ref`. */
  returnForm(account: GatewayAccount, ref: string): Record<string, string> {
    return {
      ref,
      reference: `T-${ref.slice(-6)}`,
      sig: createHmac('sha256', account.credentials.secret ?? '')
        .update(ref)
        .digest('hex'),
    };
  }

  returned(account: GatewayAccount, form: Readonly<Record<string, string>>): GatewayPayment | null {
    const { ref, sig, reference } = form;
    if (!ref || !sig || !sameHex(sig, this.returnForm(account, ref).sig!)) return null;
    return { ref, amount: null, currency: null, reference: reference || null };
  }

  /** A webhook saying `ref` is paid: `amount` in minor units. */
  webhookFor(
    account: GatewayAccount,
    payment: { ref: string; amount: bigint; reference?: string },
  ): GatewayWebhook {
    const body = Buffer.from(
      JSON.stringify({
        ref: payment.ref,
        amount: payment.amount.toString(),
        reference: payment.reference ?? `T-${payment.ref.slice(-6)}`,
        paid: true,
      }),
    );
    return { body, headers: { 'x-test-signature': this.#sign(account, body) } };
  }

  webhook(account: GatewayAccount, request: GatewayWebhook): GatewayPayment | 'unsigned' | null {
    const signature = request.headers['x-test-signature'];
    if (!signature || !sameHex(signature, this.#sign(account, request.body))) return 'unsigned';
    const event = JSON.parse(request.body.toString('utf8')) as {
      ref?: string;
      amount?: string;
      reference?: string;
      paid?: boolean;
    };
    if (!event.paid || !event.ref) return null;
    return {
      ref: event.ref,
      amount: event.amount ? BigInt(event.amount) : null,
      currency: null,
      reference: event.reference ?? null,
    };
  }

  async refund(
    _account: GatewayAccount,
    request: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    await this.whileRefunding?.();
    const answer = this.refundAnswer;
    if (answer === 'silent') {
      return { ok: false, unknown: true, message: 'Test gateway did not answer in time' };
    }
    if (answer) return { ok: false, unknown: false, message: answer.refuse };
    const reference = `TR-${randomBytes(3).toString('hex')}`;
    this.refunds.push({ ...request, reference });
    return { ok: true, reference };
  }

  #sign(account: GatewayAccount, body: Buffer): string {
    return createHmac('sha256', account.credentials.secret ?? '')
      .update(body)
      .digest('hex');
  }
}

/** Network errors that come before a request is sent: it never reached the gateway. */
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Whether `error`, from fetch, says the request never left: no connection was made. */
function notConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' && NOT_CONNECTED.has(cause.code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two hex digests are the same, in constant time. */
function sameHex(given: string, expected: string): boolean {
  const [a, b] = [Buffer.from(given.trim().toLowerCase()), Buffer.from(expected)];
  return a.length === b.length && timingSafeEqual(a, b);
}

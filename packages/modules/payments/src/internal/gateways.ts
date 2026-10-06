import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
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
  /** What it must look like, where the gateway gives it in one shape alone. */
  pattern?: RegExp;
  /** What connecting says of one not so, as "must be …". */
  problem?: string;
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

/**
 * Who pays, and for what, for a gateway that asks with a checkout (ADR-226), as PayFast's names
 * the customer's number and email: the order's customer, where it goes, its items at their prices
 * and its delivery charge. What an erasure took off is null.
 */
export interface GatewayBuyer {
  name: string | null;
  /** E.164: "+923001234567". */
  phone: string | null;
  email: string | null;
  address: {
    address1: string;
    address2: string | null;
    city: string;
    /** "Punjab". */
    province: string | null;
    zip: string | null;
  } | null;
  /** Minor units, as each unit's price. */
  lines: readonly { name: string; sku: string | null; quantity: number; unitPrice: bigint }[];
  /** Minor units. */
  shipping: bigint;
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
  /** Who pays, and for what, for a gateway that asks (ADR-226). */
  buyer?: GatewayBuyer;
  /**
   * The account's webhook address, for a gateway that is told where to send word of the payment
   * with each checkout, as PayFast is (ADR-226).
   */
  notifyUrl?: string;
}

/** A checkout the gateway started. */
export interface GatewayCheckout {
  /** The gateway's name for the payment, such as Safepay's tracker. */
  ref: string;
  /** The gateway's page to send the customer to. */
  url: string;
  /**
   * The fields the customer's browser posts to {@link url}, for a gateway whose page is reached by
   * a form, as JazzCash's is; absent for one that is linked to.
   */
  form?: Readonly<Record<string, string>>;
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

/**
 * What a gateway says of a payment it was asked after (ADR-208): made, as it vouches for it; not
 * made, or not yet; or not known, as when it could not be asked or its answer not believed.
 */
export type GatewayInquiry =
  { status: 'paid'; payment: GatewayPayment } | { status: 'unpaid' | 'unknown'; message: string };

/** A page of the gateway's that the customer's browser posts `form` to. */
export interface GatewayForm {
  url: string;
  form: Readonly<Record<string, string>>;
}

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
   * The customer came back partway, as Easypaisa's page sends them back with a token for its next
   * one (ADR-214): that page, and what their browser posts there, with `returnUrl` to come back to
   * once they paid; null when `form` is no such return. Absent when the gateway's pages need none.
   */
  continued?(
    account: GatewayAccount,
    form: Readonly<Record<string, string>>,
    returnUrl: string,
  ): GatewayForm | null;
  /**
   * For a gateway whose return is not signed, as Easypaisa's is not (ADR-214): its name for the
   * payment `form` says is made, which the gateway is then asked after at once with
   * {@link inquire}; null when it says none is.
   */
  returnRef?(form: Readonly<Record<string, string>>): string | null;
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
  /**
   * Asks the gateway what became of the payment `ref` names, as of one whose customer never came
   * back from its page (ADR-208); absent when it cannot be asked. Asked as the customer comes
   * back, `returned` is what they came back with, as Baadmay's return names its own ID for the
   * payment, which its status takes (ADR-226).
   */
  inquire?(
    account: GatewayAccount,
    ref: string,
    returned?: Readonly<Record<string, string>>,
  ): Promise<GatewayInquiry>;
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

  /** The gateways that can be asked what became of a payment (ADR-208), by key. */
  get inquirable(): string[] {
    return [...this.#gateways.values()]
      .filter((gateway) => gateway.inquire !== undefined)
      .map((gateway) => gateway.info.gateway);
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

/** Where Safepay's reporter gives a tracker as it stands, by its token (ADR-210). */
export const SAFEPAY_TRACKER_PATH = '/reporter/api/v1/payments/';

/** The state of a tracker whose payment is made. */
const SAFEPAY_PAID = 'TRACKER_ENDED';

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

  /**
   * Asks Safepay's reporter how the tracker `ref` stands (ADR-210), with the account's secret
   * key, as its documents fetch a tracker. Its answer is not signed: it is believed as it comes
   * from Safepay's own API, as a refund's answer is, and only when it names the account's API key
   * and no other tracker. Paid once the tracker ended, at the amount it was started for, which
   * Hatti set; not yet while it has not; unknown when Safepay could not be asked, or answered
   * anything else.
   */
  async inquire(account: GatewayAccount, ref: string): Promise<GatewayInquiry> {
    const urls = this.#urls(account.environment);
    let response: Response;
    try {
      response = await fetch(`${urls.api}${SAFEPAY_TRACKER_PATH}${encodeURIComponent(ref)}`, {
        headers: {
          accept: 'application/json',
          'x-sfpy-merchant-secret': account.credentials.secretKey ?? '',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const message = `Safepay could not be reached: ${(error as Error).message}`;
      return { status: 'unknown', message: message.slice(0, 1_000) };
    }
    const json: unknown = await response.json().catch(() => null);
    const tracker = isObject(json) && isObject(json.data) ? json.data : null;
    if (!response.ok || !tracker) {
      return { status: 'unknown', message: `Safepay answered ${response.status}` };
    }
    // The account it names, as its API key, whether alone or with the rest of the account's.
    const client = isObject(tracker.client) ? tracker.client.api_key : tracker.client;
    if (!account.credentials.apiKey || client !== account.credentials.apiKey) {
      return { status: 'unknown', message: "Safepay's answer named another account" };
    }
    if (typeof tracker.token === 'string' && tracker.token !== ref) {
      return { status: 'unknown', message: "Safepay's answer named another tracker" };
    }
    const state = typeof tracker.state === 'string' ? tracker.state.trim() : '';
    if (state === '') return { status: 'unknown', message: "Safepay's answer had no state" };
    if (state !== SAFEPAY_PAID) {
      return { status: 'unpaid', message: `Safepay: the tracker is ${state}`.slice(0, 1_000) };
    }
    const reference = tracker.reference;
    return {
      status: 'paid',
      payment: {
        ref,
        amount: null,
        currency: null,
        reference:
          typeof reference === 'string' || typeof reference === 'number'
            ? String(reference).trim().slice(0, 200) || null
            : null,
      },
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

/** Where JazzCash's hosted checkout answers, in each of its environments. */
export const JAZZCASH_URLS: Readonly<Record<GatewayEnvironmentValue, string>> = {
  sandbox: 'https://sandbox.jazzcash.com.pk',
  production: 'https://payments.jazzcash.com.pk',
};

/** Its hosted checkout's page, which the customer's browser posts the signed form to. */
const JAZZCASH_FORM_PATH = '/CustomerPortal/transactionmanagement/merchantform/';

/** Its status inquiry, which asks after a transaction by its reference (ADR-208). */
const JAZZCASH_INQUIRY_PATH = '/ApplicationAPI/API/PaymentInquiry/Inquire';

/** The codes its inquiry gives a payment completed with. */
const JAZZCASH_PAID = new Set(['000', '121']);

export interface JazzCashOptions {
  /** {@link JAZZCASH_URLS}, unless a test says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, string>>;
  /** How long its page takes the payment for, as a voucher paid at a shop needs: a day. */
  expiresInMs?: number;
  /** How long its inquiry may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/**
 * JazzCash (https://www.jazzcash.com.pk), its hosted checkout as its page redirection v1.1 has
 * it: the customer's browser posts a form to JazzCash's page, for the amount and a transaction
 * reference of Hatti's, signed with the account's integrity salt; JazzCash's page takes a card,
 * a JazzCash wallet or a voucher paid at a shop, and posts the outcome to the return address,
 * signed the same way, as its instant payment notification does. The form carries the account's
 * merchant ID and password, as JazzCash asks of it; the salt, which signs, never leaves Hatti.
 * Its status inquiry is asked after a payment whose customer never came back (ADR-208). Nothing
 * is given back through its API here.
 */
export class JazzCashGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'jazzcash',
    name: 'JazzCash',
    credentials: [
      { key: 'merchantId', label: 'Merchant ID' },
      { key: 'password', label: 'Password' },
      { key: 'integritySalt', label: 'Integrity salt' },
    ],
    currencies: ['PKR'],
    test: false,
    refunds: 'none',
  };

  constructor(private readonly options: JazzCashOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#url(environment)).origin;
  }

  /** The signed form for JazzCash's page: nothing to ask JazzCash before the customer goes. */
  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (request.currency !== 'PKR') {
      return { ok: false, retry: false, message: 'JazzCash takes payments in rupees alone' };
    }
    const now = new Date();
    const expires = new Date(now.getTime() + (this.options.expiresInMs ?? 24 * 3_600_000));
    // Its reference for the payment, unique to the account: when, in Pakistan, and five digits.
    const ref = `T${pakistanTime(now)}${randomInt(100_000).toString().padStart(5, '0')}`;
    const bill = request.orderName.replace(/[^A-Za-z0-9]/g, '') || 'order';
    const form: Record<string, string> = {
      pp_Version: '1.1',
      // Blank, so that its page offers every way the account takes.
      pp_TxnType: '',
      pp_Language: 'EN',
      pp_MerchantID: account.credentials.merchantId ?? '',
      pp_SubMerchantID: '',
      pp_Password: account.credentials.password ?? '',
      pp_BankID: '',
      pp_ProductID: '',
      pp_TxnRefNo: ref,
      // In paisa, as amounts are kept here.
      pp_Amount: request.amount.toString(),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: pakistanTime(now),
      pp_BillReference: bill,
      pp_Description: `Order ${bill}`,
      pp_TxnExpiryDateTime: pakistanTime(expires),
      pp_ReturnURL: request.returnUrl,
      ppmpf_1: '',
      ppmpf_2: '',
      ppmpf_3: '',
      ppmpf_4: '',
      ppmpf_5: '',
    };
    form.pp_SecureHash = jazzCashHash(account.credentials.integritySalt ?? '', form, false);
    const url = `${this.#url(account.environment)}${JAZZCASH_FORM_PATH}`;
    return { ok: true, value: { ref, url, form } };
  }

  /**
   * JazzCash posts the outcome to the return address, signed with the integrity salt: a payment
   * when its response code is 000, the amount in paisa.
   */
  returned(account: GatewayAccount, form: Readonly<Record<string, string>>): GatewayPayment | null {
    const outcome = this.#signed(account, form);
    return outcome === 'unsigned' ? null : outcome;
  }

  /**
   * Its instant payment notification, where the account has one set up: the same fields, posted
   * as JSON or as a form, signed the same way.
   */
  webhook(account: GatewayAccount, request: GatewayWebhook): GatewayPayment | 'unsigned' | null {
    const text = request.body.toString('utf8');
    let fields: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) return 'unsigned';
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number') fields[key] = String(value);
      }
    } catch {
      fields = Object.fromEntries(new URLSearchParams(text));
    }
    return this.#signed(account, fields);
  }

  /**
   * Asks its status inquiry after the transaction `ref` (ADR-208), with the merchant ID and
   * password, signed with the integrity salt as its forms are; its answer is believed only signed
   * with the salt too. Paid when the inquiry succeeded (000) and the payment's code is one of a
   * completed payment, 000 or 121, its status, where it gives one, completed; not paid for any
   * other code, as a voucher not paid yet; unknown when JazzCash could not be asked, or answered
   * anything else.
   */
  async inquire(account: GatewayAccount, ref: string): Promise<GatewayInquiry> {
    const salt = account.credentials.integritySalt ?? '';
    const fields: Record<string, string> = {
      pp_TxnRefNo: ref,
      pp_MerchantID: account.credentials.merchantId ?? '',
      pp_Password: account.credentials.password ?? '',
    };
    let response: Response;
    try {
      response = await fetch(`${this.#url(account.environment)}${JAZZCASH_INQUIRY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...fields, pp_SecureHash: jazzCashHash(salt, fields, false) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const message = `JazzCash could not be reached: ${(error as Error).message}`;
      return { status: 'unknown', message: message.slice(0, 1_000) };
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok || !isObject(json)) {
      return { status: 'unknown', message: `JazzCash answered ${response.status}` };
    }
    const answer: Record<string, string> = {};
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === 'string' || typeof value === 'number') answer[key] = String(value);
    }
    const outcome = this.#signed(account, answer);
    if (outcome === 'unsigned') {
      return { status: 'unknown', message: "JazzCash's answer was not signed with the salt" };
    }
    if (answer.pp_ResponseCode !== '000') {
      const said = answer.pp_ResponseMessage?.trim() || `it answered ${answer.pp_ResponseCode}`;
      return { status: 'unknown', message: `JazzCash: ${said}`.slice(0, 1_000) };
    }
    const code = answer.pp_PaymentResponseCode?.trim() ?? '';
    const status = answer.pp_Status?.trim();
    if (!JAZZCASH_PAID.has(code) || (status && !/^completed$/i.test(status))) {
      const said = answer.pp_PaymentResponseMessage?.trim() || status || `code ${code || 'none'}`;
      return { status: 'unpaid', message: `JazzCash: ${said}`.slice(0, 1_000) };
    }
    const paid = /^\d{1,15}$/.test(answer.pp_Amount ?? '') ? BigInt(answer.pp_Amount!) : 0n;
    const reference = (answer.pp_RetreivalReferenceNo || answer.pp_AuthCode || '').trim();
    return {
      status: 'paid',
      payment: {
        ref,
        amount: paid > 0n ? paid : null,
        currency: paid > 0n ? answer.pp_TxnCurrency?.trim() || 'PKR' : null,
        reference: reference.slice(0, 200) || null,
      },
    };
  }

  /** The payment `fields` say is made, if signed with the account's salt; or `unsigned`. */
  #signed(
    account: GatewayAccount,
    fields: Readonly<Record<string, string>>,
  ): GatewayPayment | 'unsigned' | null {
    const salt = account.credentials.integritySalt;
    const given = fields.pp_SecureHash;
    if (!salt || !given) return 'unsigned';
    // Some of its integrations leave "0" out of what they sign, as PHP's empty() does: either holds.
    const signed =
      sameHex(given, jazzCashHash(salt, fields, false)) ||
      sameHex(given, jazzCashHash(salt, fields, true));
    if (!signed) return 'unsigned';
    const ref = fields.pp_TxnRefNo?.trim() ?? '';
    if (fields.pp_ResponseCode !== '000' || ref === '') return null;
    const paid = /^\d{1,15}$/.test(fields.pp_Amount ?? '') ? BigInt(fields.pp_Amount!) : 0n;
    const reference = (fields.pp_RetreivalReferenceNo || fields.pp_AuthCode || '').trim();
    return {
      ref,
      amount: paid > 0n ? paid : null,
      currency: paid > 0n ? fields.pp_TxnCurrency?.trim() || 'PKR' : null,
      reference: reference.slice(0, 200) || null,
    };
  }

  #url(environment: GatewayEnvironmentValue): string {
    return (this.options.urls?.[environment] ?? JAZZCASH_URLS[environment]).replace(/\/+$/, '');
  }
}

/**
 * JazzCash's secure hash of a form: HMAC-SHA256, keyed with the integrity salt, of the salt and
 * the values of its fields, those of `pp_` and `ppmpf_` but the hash, sorted by name, the blank
 * left out, each after an "&"; in hex. `withoutZeros` leaves out "0" too.
 */
export function jazzCashHash(
  salt: string,
  fields: Readonly<Record<string, string>>,
  withoutZeros: boolean,
): string {
  const values = Object.keys(fields)
    .filter((key) => /^pp(mpf)?_/.test(key) && key !== 'pp_SecureHash')
    .sort()
    .map((key) => fields[key]!)
    .filter((value) => value !== '' && !(withoutZeros && value === '0'));
  return createHmac('sha256', salt)
    .update([salt, ...values].join('&'), 'utf8')
    .digest('hex');
}

/** When, in Pakistan's time, as JazzCash writes it: 20261002143000. */
function pakistanTime(at: Date): string {
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().replace(/\D/g, '').slice(0, 14);
}

/** Where Easypaisa's hosted checkout and its API answer, in each of its environments. */
export const EASYPAISA_URLS: Readonly<Record<GatewayEnvironmentValue, string>> = {
  sandbox: 'https://easypaystg.easypaisa.com.pk',
  production: 'https://easypay.easypaisa.com.pk',
};

/** Its hosted checkout's page, which the customer's browser posts the order's form to. */
const EASYPAISA_FORM_PATH = '/easypay/Index.jsf';

/** Its next page, which the browser posts the token Easypaisa sent it back with to. */
const EASYPAISA_CONFIRM_PATH = '/easypay/Confirm.jsf';

/** Its inquiry, which asks after a payment by the order's reference (ADR-214). */
const EASYPAISA_INQUIRY_PATH = '/easypay-service/rest/v4/inquire-transaction';

/** The code its return and its API give what succeeded. */
const EASYPAISA_SUCCESS = '0000';

/** The cipher its hash takes for a key of each length: AES in ECB mode, as its guide has it. */
const EASYPAISA_CIPHERS: Readonly<Record<number, string>> = {
  16: 'aes-128-ecb',
  24: 'aes-192-ecb',
  32: 'aes-256-ecb',
};

export interface EasypaisaOptions {
  /** {@link EASYPAISA_URLS}, unless a test says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, string>>;
  /** How long its page takes the payment for, as a token paid at a shop needs: a day. */
  expiresInMs?: number;
  /** How long its inquiry may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/**
 * Easypaisa (https://easypaisa.com.pk), its hosted checkout as its merchant integration guide has
 * it: the customer's browser posts a form to Easypaisa's page for the amount and an order
 * reference of Hatti's, with the store's ID and those fields encrypted with the store's hash key;
 * Easypaisa's page takes a wallet, a card or a token paid at a shop, sends the browser back with a
 * token that it posts to Easypaisa's next page, and then back again saying how the payment went.
 * That return is not signed, so a payment it says is made is recorded only once Easypaisa's
 * inquiry says so too, asked at once with the account's API credentials, as for a payment whose
 * customer never came back (ADR-208, ADR-214). Its IPN is not followed, and nothing is given back
 * through its API here.
 */
export class EasypaisaGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'easypaisa',
    name: 'Easypaisa',
    credentials: [
      {
        key: 'storeId',
        label: 'Store ID',
        pattern: /^\d{1,12}$/,
        problem: "must be the store's ID, in digits, as Easypaisa gave it",
      },
      {
        key: 'hashKey',
        label: 'Hash key',
        pattern: /^(?:.{16}|.{24}|.{32})$/,
        problem: 'must be the 16, 24 or 32 characters Easypaisa gave',
      },
      {
        key: 'accountNum',
        label: 'Account number',
        pattern: /^\d{1,24}$/,
        problem: "must be the store's Easypaisa account number, in digits",
      },
      { key: 'username', label: 'API username' },
      { key: 'password', label: 'API password' },
    ],
    currencies: ['PKR'],
    test: false,
    refunds: 'none',
  };

  constructor(private readonly options: EasypaisaOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#url(environment)).origin;
  }

  /** The form for Easypaisa's page, its hash made with the store's key: nothing asked before. */
  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (request.currency !== 'PKR') {
      return { ok: false, retry: false, message: 'Easypaisa takes payments in rupees alone' };
    }
    const key = account.credentials.hashKey ?? '';
    if (!EASYPAISA_CIPHERS[Buffer.byteLength(key, 'utf8')]) {
      return {
        ok: false,
        retry: false,
        message: "Easypaisa's hash key is not 16, 24 or 32 characters long",
      };
    }
    const now = new Date();
    const expires = new Date(now.getTime() + (this.options.expiresInMs ?? 24 * 3_600_000));
    // Its reference for the order, unique to the store: when, in Pakistan, and five digits.
    const ref = `E${pakistanTime(now)}${randomInt(100_000).toString().padStart(5, '0')}`;
    const when = pakistanTime(expires);
    const fields: Record<string, string> = {
      amount: easypaisaAmount(request.amount),
      // Back to the return address as soon as it is paid, rather than on a button of its page.
      autoRedirect: '1',
      expiryDate: `${when.slice(0, 8)} ${when.slice(8)}`,
      orderRefNum: ref,
      postBackURL: request.returnUrl,
      storeId: account.credentials.storeId ?? '',
    };
    const form = { ...fields, merchantHashedReq: easypaisaHash(key, fields) };
    return {
      ok: true,
      value: { ref, url: `${this.#url(account.environment)}${EASYPAISA_FORM_PATH}`, form },
    };
  }

  /** Its return is not signed: nothing is believed of it alone ({@link returnRef}). */
  returned(): GatewayPayment | null {
    return null;
  }

  /**
   * Easypaisa sends the browser back with `auth_token` once the customer chose how to pay: the
   * browser posts it to its next page, with the address to come back to after.
   */
  continued(
    account: GatewayAccount,
    form: Readonly<Record<string, string>>,
    returnUrl: string,
  ): GatewayForm | null {
    const token = form.auth_token?.trim() ?? '';
    if (!/^[!-~]{1,512}$/.test(token)) return null;
    return {
      url: `${this.#url(account.environment)}${EASYPAISA_CONFIRM_PATH}`,
      form: { auth_token: token, postBackURL: returnUrl },
    };
  }

  /** The order it says is paid, by its `status` of 0000: asked after at once to be believed. */
  returnRef(form: Readonly<Record<string, string>>): string | null {
    const ref = (form.orderRefNumber ?? form.orderRefNum)?.trim() ?? '';
    return form.status?.trim() === EASYPAISA_SUCCESS && /^[!-~]{1,64}$/.test(ref) ? ref : null;
  }

  /** Its IPN is not followed: its inquiry is asked instead. */
  webhook(): GatewayPayment | 'unsigned' | null {
    return null;
  }

  /**
   * Asks its inquiry after the order `ref` (ADR-208), with the account's API username and
   * password, for the store and its account number. Its answer is not signed, so it is believed as
   * coming from Easypaisa's own API, and only naming the account's store and the order asked
   * after (ADR-210): paid when it succeeded (0000) and says the payment is PAID; not paid for any
   * other status, such as a token not paid yet; unknown when Easypaisa could not be asked, or
   * answered anything else.
   */
  async inquire(account: GatewayAccount, ref: string): Promise<GatewayInquiry> {
    const { storeId = '', accountNum = '', username = '', password = '' } = account.credentials;
    let response: Response;
    try {
      response = await fetch(`${this.#url(account.environment)}${EASYPAISA_INQUIRY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          credentials: Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
        },
        body: JSON.stringify({ orderId: ref, storeId, accountNum }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const message = `Easypaisa could not be reached: ${(error as Error).message}`;
      return { status: 'unknown', message: message.slice(0, 1_000) };
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok || !isObject(json)) {
      return { status: 'unknown', message: `Easypaisa answered ${response.status}` };
    }
    const said = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (said(json.responseCode) !== EASYPAISA_SUCCESS) {
      const desc = said(json.responseDesc) || `it answered ${said(json.responseCode) || 'nothing'}`;
      return { status: 'unknown', message: `Easypaisa: ${desc}`.slice(0, 1_000) };
    }
    if (said(json.storeId) !== storeId || said(json.orderId) !== ref) {
      return { status: 'unknown', message: "Easypaisa's answer named another store or order" };
    }
    const status = said(json.transactionStatus).toUpperCase();
    if (status === '') return { status: 'unknown', message: "Easypaisa's answer had no status" };
    if (status !== 'PAID') {
      return { status: 'unpaid', message: `Easypaisa: the payment is ${status}`.slice(0, 1_000) };
    }
    let paid: bigint;
    try {
      paid = fromMajor(said(json.transactionAmount), 'PKR').amount;
    } catch {
      paid = 0n;
    }
    const reference = said(json.transactionId);
    return {
      status: 'paid',
      payment: {
        ref,
        amount: paid > 0n ? paid : null,
        currency: paid > 0n ? 'PKR' : null,
        reference: reference.slice(0, 200) || null,
      },
    };
  }

  #url(environment: GatewayEnvironmentValue): string {
    return (this.options.urls?.[environment] ?? EASYPAISA_URLS[environment]).replace(/\/+$/, '');
  }
}

/**
 * Easypaisa's hash of its form, `merchantHashedReq`: its fields that have a value, by their names,
 * each as name=value, joined by "&", encrypted with AES in ECB mode with the store's hash key as
 * it is (16, 24 or 32 characters), padded as PKCS#5 pads; in Base64.
 */
export function easypaisaHash(key: string, fields: Readonly<Record<string, string>>): string {
  const text = Object.keys(fields)
    .sort()
    .filter((name) => fields[name] !== '')
    .map((name) => `${name}=${fields[name]}`)
    .join('&');
  const secret = Buffer.from(key, 'utf8');
  const cipher = createCipheriv(EASYPAISA_CIPHERS[secret.length] ?? 'aes-128-ecb', secret, null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

/** Rupees as Easypaisa's form writes them: 2500.0, or with paisa 2500.50. */
function easypaisaAmount(paisa: bigint): string {
  const rest = paisa % 100n;
  return `${paisa / 100n}.${rest === 0n ? '0' : rest.toString().padStart(2, '0')}`;
}

/** Where Baadmay's checkout page and its API answer, in one of its environments. */
export interface BaadmayUrls {
  checkout: string;
  api: string;
}

/**
 * Where Baadmay's page and its API answer, in each of its environments, as its integration
 * document names them; Baadmay may give a shop others when it goes live.
 */
export const BAADMAY_URLS: Readonly<Record<GatewayEnvironmentValue, BaadmayUrls>> = {
  sandbox: { checkout: 'https://webdev.baadmay.com', api: 'https://devip.baadmay.com' },
  production: { checkout: 'https://web.baadmay.com', api: 'https://api.baadmay.com' },
};

/** Its order status, which asks after an order by Baadmay's ID for it. */
const BAADMAY_ORDER_PATH = '/v1/orders/';

/** The query parameter the return address carries Hatti's reference for the order in. */
const BAADMAY_REF_PARAM = 'order_ref';

/** The statuses its answer gives an order paid, and one not paid or not yet. */
const BAADMAY_PAID = /^(success|successful|succeeded|complete|completed|paid|approved|captured)$/i;
const BAADMAY_UNPAID =
  /^(pending|processing|in[ _-]?progress|initiated|created|failed|failure|cancell?ed|declined|rejected|expired|abandoned)$/i;

export interface BaadmayOptions {
  /** {@link BAADMAY_URLS}, unless a test or the shop's onboarding says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, BaadmayUrls>>;
  /** How long its status may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/**
 * Baadmay (https://baadmay.com), Pakistan's buy now, pay later, as its integration document has
 * it: the order, its items and its customer, with the account's API key, go to Baadmay's page as
 * JSON in Base64 in the address; the customer pays a third there and the rest over two months,
 * and Baadmay pays the shop. Its page sends the customer back with Baadmay's ID for the order,
 * unsigned, and it sends no webhook: a payment it says is made is recorded only once its order
 * status, asked at once with the API key, says it is paid, naming Hatti's reference for the
 * order and its amount (ADR-226). Nothing is given back through its API: the shop asks Baadmay.
 */
export class BaadmayGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'baadmay',
    name: 'Baadmay',
    credentials: [{ key: 'apiKey', label: 'API key' }],
    currencies: ['PKR'],
    test: false,
    refunds: 'none',
  };

  constructor(private readonly options: BaadmayOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#urls(environment).checkout).origin;
  }

  /** The address of Baadmay's page with the order in it: nothing asked of Baadmay before. */
  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (request.currency !== 'PKR') {
      return { ok: false, retry: false, message: 'Baadmay takes payments in rupees alone' };
    }
    const now = new Date();
    // Hatti's reference for the order, unique to the account: when, in Pakistan, and five digits.
    const ref = `B${pakistanTime(now)}${randomInt(100_000).toString().padStart(5, '0')}`;
    const when = pakistanTime(now);
    const rupees = (paisa: bigint) => Number(toMajorString(money(paisa, 'PKR')));
    const buyer = request.buyer;
    // Its items, where they and the delivery charge come to what is asked; else the order as one.
    const itemized =
      buyer !== undefined &&
      buyer.lines.length > 0 &&
      buyer.lines.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n) +
        buyer.shipping ===
        request.amount;
    const items = itemized
      ? buyer.lines.map((line, index) => ({
          itemId: String(index + 1),
          sku: line.sku ?? '',
          name: line.name,
          qty: line.quantity,
          price: rupees(line.unitPrice),
        }))
      : [
          {
            itemId: '1',
            sku: '',
            name: `Order ${request.orderName}`,
            qty: 1,
            price: rupees(request.amount),
          },
        ];
    const [firstname = '', ...rest] = (buyer?.name ?? '').trim().split(/\s+/);
    const phone = buyer?.phone ? nationalNumber(buyer.phone) : '';
    const person = {
      firstname,
      lastname: rest.join(' '),
      address: [buyer?.address?.address1 ?? '', buyer?.address?.address2 ?? ''],
      city: buyer?.address?.city ?? '',
      state: buyer?.address?.province ?? '',
      postcode: buyer?.address?.zip ?? '',
      // Its document's name for the number, and the one its open library sends.
      telephone: phone,
      phone,
      email: buyer?.email ?? '',
    };
    const back = new URL(request.returnUrl);
    back.searchParams.set(BAADMAY_REF_PARAM, ref);
    const order = {
      apiKey: account.credentials.apiKey ?? '',
      orderId: ref,
      createdAt: `${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)} ${when.slice(8, 10)}:${when.slice(10, 12)}:${when.slice(12, 14)}`,
      totalAmount: rupees(request.amount),
      items,
      customer: person,
      billing: person,
      shipping: { method: 'Delivery', cost: itemized ? rupees(buyer.shipping) : 0, ...person },
      // Its document's names for the addresses, and the ones its open library sends.
      successUrl: back.toString(),
      failedUrl: request.cancelUrl,
      success_url: back.toString(),
      failure_url: request.cancelUrl,
    };
    const q = Buffer.from(JSON.stringify(order), 'utf8').toString('base64');
    return { ok: true, value: { ref, url: `${this.#urls(account.environment).checkout}/?q=${q}` } };
  }

  /** Its return is not signed: nothing is believed of it alone ({@link returnRef}). */
  returned(): GatewayPayment | null {
    return null;
  }

  /**
   * Hatti's reference for the order, which the return address carries, and Baadmay's ID for it,
   * which Baadmay adds: asked after at once to be believed. Baadmay may add its ID after a "?"
   * of its own, which then reads as part of the reference.
   */
  returnRef(form: Readonly<Record<string, string>>): string | null {
    const ref = baadmayReturn(form).ref;
    return /^B\d{19}$/.test(ref) ? ref : null;
  }

  /** It sends no webhook: its order status is asked instead. */
  webhook(): GatewayPayment | 'unsigned' | null {
    return null;
  }

  /**
   * Asks its order status after the order (ADR-226), with the API key: by Baadmay's ID for it
   * where the customer came back with one, else by Hatti's reference. Its answer is not signed,
   * so it is believed as coming from Baadmay's own API, and only naming Hatti's reference for
   * the order and the amount paid: paid when its status says so; not paid for a status of one
   * failed, cancelled or still under way; unknown when Baadmay could not be asked, or answered
   * anything else.
   */
  async inquire(
    account: GatewayAccount,
    ref: string,
    returned?: Readonly<Record<string, string>>,
  ): Promise<GatewayInquiry> {
    const given = returned ? baadmayReturn(returned) : null;
    const id = given?.ref === ref && given.baadmay ? given.baadmay : ref;
    let response: Response;
    try {
      response = await fetch(
        `${this.#urls(account.environment).api}${BAADMAY_ORDER_PATH}${encodeURIComponent(id)}`,
        {
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            // The key alone, as Baadmay takes it.
            authorization: account.credentials.apiKey ?? '',
          },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        },
      );
    } catch (error) {
      const message = `Baadmay could not be reached: ${(error as Error).message}`;
      return { status: 'unknown', message: message.slice(0, 1_000) };
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok || !isObject(json)) {
      return { status: 'unknown', message: `Baadmay answered ${response.status}` };
    }
    const order = isObject(json.data) ? json.data : json;
    const said = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
      }
      return '';
    };
    const status = said(order.status, order.orderStatus, order.paymentStatus);
    if (status === '') return { status: 'unknown', message: "Baadmay's answer had no status" };
    if (BAADMAY_UNPAID.test(status)) {
      return { status: 'unpaid', message: `Baadmay: the order is ${status}`.slice(0, 1_000) };
    }
    if (!BAADMAY_PAID.test(status)) {
      return { status: 'unknown', message: `Baadmay: the order is ${status}`.slice(0, 1_000) };
    }
    if (said(order.orderId, order.merchantOrderId, order.order_id) !== ref) {
      return { status: 'unknown', message: "Baadmay's answer named another order" };
    }
    let paid: bigint;
    try {
      paid = fromMajor(said(order.totalAmount, order.amount, order.total_amount), 'PKR').amount;
    } catch {
      paid = 0n;
    }
    if (paid <= 0n) return { status: 'unknown', message: "Baadmay's answer had no amount" };
    const reference = said(order.baadmayOrderId, order.baadmay_order_id) || (id !== ref ? id : '');
    return {
      status: 'paid',
      payment: { ref, amount: paid, currency: 'PKR', reference: reference.slice(0, 200) || null },
    };
  }

  #urls(environment: GatewayEnvironmentValue): BaadmayUrls {
    const urls = this.options.urls?.[environment] ?? BAADMAY_URLS[environment];
    return { checkout: urls.checkout.replace(/\/+$/, ''), api: urls.api.replace(/\/+$/, '') };
  }
}

/**
 * What Baadmay's return says: Hatti's reference for the order, and Baadmay's ID for it, whether
 * Baadmay joined its parameter with a "&" or with a "?" of its own.
 */
function baadmayReturn(form: Readonly<Record<string, string>>): { ref: string; baadmay: string } {
  const value = form[BAADMAY_REF_PARAM]?.trim() ?? '';
  const at = value.indexOf('?');
  const ref = at === -1 ? value : value.slice(0, at);
  const joined = at === -1 ? null : new URLSearchParams(value.slice(at + 1)).get('baadmayOrderId');
  const baadmay = (form.baadmayOrderId ?? joined ?? '').trim();
  return { ref, baadmay: /^[!-~]{1,100}$/.test(baadmay) ? baadmay : '' };
}

/** A number in E.164 as Pakistan writes it: +923001234567 is 03001234567. */
function nationalNumber(e164: string): string {
  return /^\+92\d{10}$/.test(e164) ? `0${e164.slice(3)}` : e164;
}

/** Where PayFast's pages and API answer, in each of its environments. */
export const PAYFAST_URLS: Readonly<Record<GatewayEnvironmentValue, string>> = {
  sandbox: 'https://ipguat.apps.net.pk',
  production: 'https://ipg1.apps.net.pk',
};

/** Where an access token is asked for, for a basket and its amount. */
const PAYFAST_TOKEN_PATH = '/Ecommerce/api/Transaction/GetAccessToken';

/** Its hosted checkout's page, which the customer's browser posts the form to. */
const PAYFAST_FORM_PATH = '/Ecommerce/api/Transaction/PostTransaction';

/** The codes its return and its notification give a payment made. */
const PAYFAST_PAID = new Set(['000', '00']);

export interface PayFastOptions {
  /** {@link PAYFAST_URLS}, unless a test says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, string>>;
  /** How long asking for a token may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/** What PayFast answers a token with. */
interface PayFastToken {
  ACCESS_TOKEN?: unknown;
  errorDescription?: unknown;
  errorCode?: unknown;
}

/**
 * PayFast (https://gopayfast.com), APPS's hosted checkout, as its redirection sample has it: an
 * access token asked for, server to server, for the basket and its amount with the account's
 * secured key; then the customer's browser posts a form with the token to PayFast's page, which
 * takes a card, a wallet or a bank account. PayFast sends the customer back, and word of the
 * payment to the account's webhook address, each with a validation hash: SHA-256 of the basket,
 * the secured key, the merchant ID and the outcome's code (ADR-227). The secured key never
 * leaves Hatti, and the token is good for that basket and amount alone. Its status API, which
 * PayFast turns on for a merchant, is not asked, and nothing is given back through its API here.
 */
export class PayFastGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'payfast',
    name: 'PayFast',
    credentials: [
      { key: 'merchantId', label: 'Merchant ID' },
      { key: 'securedKey', label: 'Secured key' },
      { key: 'merchantName', label: 'Merchant name' },
    ],
    currencies: ['PKR'],
    test: false,
    refunds: 'none',
  };

  constructor(private readonly options: PayFastOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#url(environment)).origin;
  }

  /** A token for the basket, asked for with the secured key, and the form for PayFast's page. */
  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (request.currency !== 'PKR') {
      return { ok: false, retry: false, message: 'PayFast takes payments in rupees alone' };
    }
    const now = new Date();
    // Hatti's basket for the payment, unique to the account: when, in Pakistan, and five digits.
    const ref = `P${pakistanTime(now)}${randomInt(100_000).toString().padStart(5, '0')}`;
    const amount = toMajorString(money(request.amount, 'PKR'));
    const { merchantId = '', securedKey = '', merchantName = '' } = account.credentials;
    const base = this.#url(account.environment);
    let response: Response;
    try {
      response = await fetch(`${base}${PAYFAST_TOKEN_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          MERCHANT_ID: merchantId,
          SECURED_KEY: securedKey,
          BASKET_ID: ref,
          TXNAMT: amount,
          CURRENCY_CODE: 'PKR',
        }).toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `PayFast could not be reached: ${(error as Error).message}`.slice(0, 1_000),
      };
    }
    const json = (await response.json().catch(() => null)) as PayFastToken | null;
    const token = json?.ACCESS_TOKEN;
    if (!response.ok || typeof token !== 'string' || !/^[!-~]{1,2000}$/.test(token)) {
      const said = typeof json?.errorDescription === 'string' ? json.errorDescription.trim() : '';
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `PayFast: ${said || `it answered ${response.status}`}`.slice(0, 1_000),
      };
    }
    const when = pakistanTime(now);
    const buyer = request.buyer;
    const form: Record<string, string> = {
      MERCHANT_ID: merchantId,
      MERCHANT_NAME: merchantName,
      TOKEN: token,
      PROCCODE: '00',
      TXNAMT: amount,
      CURRENCY_CODE: 'PKR',
      BASKET_ID: ref,
      ORDER_DATE: `${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)} ${when.slice(8, 10)}:${when.slice(10, 12)}:${when.slice(12, 14)}`,
      SUCCESS_URL: request.returnUrl,
      // A payment that failed goes back to the page it came from, to try again.
      FAILURE_URL: request.cancelUrl,
      // Where PayFast sends word of the payment: the account's webhook address.
      CHECKOUT_URL: request.notifyUrl ?? '',
      CUSTOMER_EMAIL_ADDRESS: buyer?.email ?? '',
      CUSTOMER_MOBILE_NO: buyer?.phone ? nationalNumber(buyer.phone) : '',
      // Nothing checks it: PayFast's own sample sends any string.
      SIGNATURE: randomBytes(8).toString('hex'),
      VERSION: 'MERCHANTCART-0.1',
      TXNDESC: `Order ${request.orderName}`,
      TRAN_TYPE: 'ECOMM_PURCHASE',
    };
    return { ok: true, value: { ref, url: `${base}${PAYFAST_FORM_PATH}`, form } };
  }

  /** PayFast sends the customer back with the outcome, its validation hash made with the key. */
  returned(account: GatewayAccount, form: Readonly<Record<string, string>>): GatewayPayment | null {
    const outcome = this.#signed(account, form);
    return outcome === 'unsigned' ? null : outcome;
  }

  /**
   * Its word of the payment, at the account's webhook address: the same fields as its return,
   * posted as a form or as JSON, or in the address, which the webhook reads as a form.
   */
  webhook(account: GatewayAccount, request: GatewayWebhook): GatewayPayment | 'unsigned' | null {
    const text = request.body.toString('utf8');
    let fields: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) return 'unsigned';
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number') fields[key] = String(value);
      }
    } catch {
      fields = Object.fromEntries(new URLSearchParams(text));
    }
    return this.#signed(account, fields);
  }

  /**
   * The payment `fields` say is made, if their validation hash holds: SHA-256, in hex, of the
   * basket, the secured key, the merchant ID and the code, each as PayFast sent it, joined by
   * "|". Made when the code is 000, or 00. The hash covers no amount: the session's own is
   * taken, which the token held PayFast to.
   */
  #signed(
    account: GatewayAccount,
    fields: Readonly<Record<string, string>>,
  ): GatewayPayment | 'unsigned' | null {
    const { merchantId, securedKey } = account.credentials;
    const given = fields.validation_hash;
    const basket = fields.basket_id ?? '';
    const code = fields.err_code ?? '';
    if (!merchantId || !securedKey || !given || basket.trim() === '') return 'unsigned';
    const expected = createHash('sha256')
      .update(`${basket}|${securedKey}|${merchantId}|${code}`, 'utf8')
      .digest('hex');
    if (!sameHex(given, expected)) return 'unsigned';
    if (!PAYFAST_PAID.has(code.trim())) return null;
    return {
      ref: basket.trim(),
      amount: null,
      currency: null,
      reference: fields.transaction_id?.trim().slice(0, 200) || null,
    };
  }

  #url(environment: GatewayEnvironmentValue): string {
    return (this.options.urls?.[environment] ?? PAYFAST_URLS[environment]).replace(/\/+$/, '');
  }
}

/** Where Bank Alfalah's payment gateway answers, in each of its environments. */
export const ALFALAH_URLS: Readonly<Record<GatewayEnvironmentValue, string>> = {
  sandbox: 'https://sandbox.bankalfalah.com',
  production: 'https://payments.bankalfalah.com',
};

/** Its handshake, which gives the token its page takes. */
const ALFALAH_HANDSHAKE_PATH = '/HS/HS/HS';

/** Its page, which the customer's browser posts the form to. */
const ALFALAH_FORM_PATH = '/SSO/SSO/SSO';

/** Its order status, by the merchant, the store and the transaction's reference. */
const ALFALAH_STATUS_PATH = '/HS/api/IPN/OrderStatus';

/** Its channel for a page the customer's browser is sent to. */
const ALFALAH_CHANNEL = '1001';

export interface AlfalahOptions {
  /** {@link ALFALAH_URLS}, unless a test says otherwise. */
  urls?: Partial<Record<GatewayEnvironmentValue, string>>;
  /** How long its handshake or status may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/**
 * Bank Alfalah's payment gateway (APG), its page redirection as its merchant integration guide
 * has it: a handshake, server to server, for a transaction reference of Hatti's, its request
 * hashed with the account's two keys; then the customer's browser posts a form with the token it
 * gave, hashed the same way, to Alfalah's page, which takes Alfa wallets, Alfalah accounts and
 * cards. The form carries the merchant's username, password and hash, as Alfalah asks of it; the
 * keys, which make the hashes, never leave Hatti. Its return is not signed, so a payment it says
 * is made is recorded only once its order status, asked at once, says so (ADR-228). Its listener
 * is not followed, and nothing is given back through its API here.
 */
export class AlfalahGateway implements PaymentGateway {
  readonly info: PaymentGatewayInfo = {
    gateway: 'alfalah',
    name: 'Bank Alfalah',
    credentials: [
      { key: 'merchantId', label: 'Merchant ID' },
      { key: 'storeId', label: 'Store ID' },
      { key: 'merchantHash', label: 'Merchant hash' },
      { key: 'merchantUsername', label: 'Merchant username' },
      { key: 'merchantPassword', label: 'Merchant password' },
      {
        key: 'key1',
        label: 'Key 1',
        pattern: /^[!-~]{16}$/,
        problem: 'must be the 16 characters Bank Alfalah gave',
      },
      {
        key: 'key2',
        label: 'Key 2',
        pattern: /^[!-~]{16}$/,
        problem: 'must be the 16 characters Bank Alfalah gave',
      },
    ],
    currencies: ['PKR'],
    test: false,
    refunds: 'none',
  };

  constructor(private readonly options: AlfalahOptions = {}) {}

  checkoutOrigin(environment: GatewayEnvironmentValue): string {
    return new URL(this.#url(environment)).origin;
  }

  /** The handshake's token, asked for with the request hashed, and the form for Alfalah's page. */
  async checkout(
    account: GatewayAccount,
    request: GatewayCheckoutRequest,
  ): Promise<GatewayResult<GatewayCheckout>> {
    if (request.currency !== 'PKR') {
      return { ok: false, retry: false, message: 'Bank Alfalah takes payments in rupees alone' };
    }
    const c = account.credentials;
    const keys = { key: c.key1 ?? '', iv: c.key2 ?? '' };
    if (Buffer.byteLength(keys.key) !== 16 || Buffer.byteLength(keys.iv) !== 16) {
      return { ok: false, retry: false, message: "Bank Alfalah's keys are not 16 characters each" };
    }
    // Its reference for the payment, unique to the account: when, in Pakistan, and five digits.
    const ref = `A${pakistanTime(new Date())}${randomInt(100_000).toString().padStart(5, '0')}`;
    const merchant = [
      c.merchantId ?? '',
      c.storeId ?? '',
      c.merchantHash ?? '',
      c.merchantUsername ?? '',
      c.merchantPassword ?? '',
    ] as const;
    // Its pairs, in its sample's order; no value may hold "&" or "=", which the return
    // address, without a query, does not.
    const handshake: [string, string][] = [
      ['HS_ChannelId', ALFALAH_CHANNEL],
      ['HS_IsRedirectionRequest', '0'],
      ['HS_MerchantId', merchant[0]],
      ['HS_StoreId', merchant[1]],
      ['HS_ReturnURL', request.returnUrl],
      ['HS_MerchantHash', merchant[2]],
      ['HS_MerchantUsername', merchant[3]],
      ['HS_MerchantPassword', merchant[4]],
      ['HS_TransactionReferenceNumber', ref],
    ];
    const base = this.#url(account.environment);
    let response: Response;
    try {
      response = await fetch(`${base}${ALFALAH_HANDSHAKE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams([
          ...handshake,
          ['HS_RequestHash', alfalahHash(keys, handshake)],
        ]).toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `Bank Alfalah could not be reached: ${(error as Error).message}`.slice(0, 1_000),
      };
    }
    const answer = alfalahJson(await response.text().catch(() => ''));
    const token = answer?.AuthToken;
    const succeeded = answer?.success === true || answer?.success === 'true';
    if (!response.ok || !succeeded || typeof token !== 'string' || !/^[!-~]{1,2000}$/.test(token)) {
      const said = typeof answer?.ErrorMessage === 'string' ? answer.ErrorMessage.trim() : '';
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `Bank Alfalah: ${said || `it answered ${response.status}`}`.slice(0, 1_000),
      };
    }
    // The return address as its handshake gave it back, as its own sample posts it.
    const back = answer?.ReturnURL;
    const form: [string, string][] = [
      // As its handshake gave it, already encoded.
      ['AuthToken', token],
      ['RequestHash', ''],
      ['ChannelId', ALFALAH_CHANNEL],
      ['Currency', 'PKR'],
      ['IsBIN', '0'],
      [
        'ReturnURL',
        typeof back === 'string' && back.trim() !== '' ? back.trim() : request.returnUrl,
      ],
      ['MerchantId', merchant[0]],
      ['StoreId', merchant[1]],
      ['MerchantHash', merchant[2]],
      ['MerchantUsername', merchant[3]],
      ['MerchantPassword', merchant[4]],
      // Blank, so that its page offers every way the account takes.
      ['TransactionTypeId', ''],
      ['TransactionReferenceNumber', ref],
      ['TransactionAmount', alfalahAmount(request.amount)],
    ];
    // Its hash covers every field, the hash's own left blank.
    const hash = alfalahHash(keys, form);
    const fields = Object.fromEntries(
      form.map(([name, value]) => [name, name === 'RequestHash' ? hash : value]),
    );
    return { ok: true, value: { ref, url: `${base}${ALFALAH_FORM_PATH}`, form: fields } };
  }

  /** Its return is not signed: nothing is believed of it alone ({@link returnRef}). */
  returned(): GatewayPayment | null {
    return null;
  }

  /** The payment it says is made, by its code of 00: asked after at once to be believed. */
  returnRef(form: Readonly<Record<string, string>>): string | null {
    const ref = form.O?.trim() ?? '';
    return form.RC?.trim() === '00' && /^A\d{19}$/.test(ref) ? ref : null;
  }

  /** Its listener is not followed: its order status is asked instead. */
  webhook(): GatewayPayment | 'unsigned' | null {
    return null;
  }

  /**
   * Asks its order status after the payment `ref` (ADR-208, ADR-228), by the account's merchant
   * and store, which it asks no secret for. Its answer is not signed, so it is believed as coming
   * from Alfalah's own API, and only naming the account's merchant and store and the payment asked
   * after: paid when it answered 00 and the payment is Paid; not paid for any other status, as
   * one failed or whose session ended; unknown when Alfalah could not be asked, or answered
   * anything else.
   */
  async inquire(account: GatewayAccount, ref: string): Promise<GatewayInquiry> {
    const { merchantId = '', storeId = '' } = account.credentials;
    const path = [merchantId, storeId, ref].map((part) => encodeURIComponent(part)).join('/');
    let response: Response;
    try {
      response = await fetch(`${this.#url(account.environment)}${ALFALAH_STATUS_PATH}/${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const message = `Bank Alfalah could not be reached: ${(error as Error).message}`;
      return { status: 'unknown', message: message.slice(0, 1_000) };
    }
    const answer = alfalahJson(await response.text().catch(() => ''));
    if (!response.ok || !answer) {
      return { status: 'unknown', message: `Bank Alfalah answered ${response.status}` };
    }
    const said = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (said(answer.ResponseCode) !== '00') {
      const description =
        said(answer.Description) || `it answered ${said(answer.ResponseCode) || 'nothing'}`;
      return { status: 'unknown', message: `Bank Alfalah: ${description}`.slice(0, 1_000) };
    }
    // Its store's ID may come without the zeros it was given with: "000456" or "456".
    const store = (value: string) => value.replace(/^0+(?=.)/, '');
    if (
      said(answer.MerchantId) !== merchantId ||
      store(said(answer.StoreId)) !== store(storeId) ||
      said(answer.TransactionReferenceNumber) !== ref
    ) {
      return {
        status: 'unknown',
        message: "Bank Alfalah's answer named another merchant, store or payment",
      };
    }
    const status = said(answer.TransactionStatus);
    if (status === '') return { status: 'unknown', message: "Bank Alfalah's answer had no status" };
    if (!/^paid$/i.test(status)) {
      return {
        status: 'unpaid',
        message: `Bank Alfalah: the payment is ${status}`.slice(0, 1_000),
      };
    }
    let paid: bigint;
    try {
      paid = fromMajor(said(answer.TransactionAmount), 'PKR').amount;
    } catch {
      paid = 0n;
    }
    const reference = said(answer.TransactionId);
    return {
      status: 'paid',
      payment: {
        ref,
        amount: paid > 0n ? paid : null,
        currency: paid > 0n ? 'PKR' : null,
        reference: reference.slice(0, 200) || null,
      },
    };
  }

  #url(environment: GatewayEnvironmentValue): string {
    return (this.options.urls?.[environment] ?? ALFALAH_URLS[environment]).replace(/\/+$/, '');
  }
}

/**
 * Bank Alfalah's hash of a request: its pairs as name=value, joined by "&", encrypted with
 * AES-128 in CBC mode, Key 1 the key and Key 2 the IV, as they are, padded as PKCS#7 pads; in
 * Base64.
 */
export function alfalahHash(
  keys: { key: string; iv: string },
  pairs: readonly (readonly [string, string])[],
): string {
  const text = pairs.map(([name, value]) => `${name}=${value}`).join('&');
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from(keys.key, 'utf8'),
    Buffer.from(keys.iv, 'utf8'),
  );
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

/** Rupees as Alfalah's form takes them: 2500, or with paisa 2500.50. */
function alfalahAmount(paisa: bigint): string {
  const rest = paisa % 100n;
  return rest === 0n
    ? (paisa / 100n).toString()
    : `${paisa / 100n}.${rest.toString().padStart(2, '0')}`;
}

/** An answer of Alfalah's, which may be JSON written into a JSON string. */
function alfalahJson(text: string): Record<string, unknown> | null {
  let value: unknown = text;
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
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
  /** What it says when asked after a payment (ADR-208), by its ref; not known unless set. */
  readonly inquiries = new Map<string, GatewayInquiry>();
  /** The payments it was asked after, the latest last. */
  readonly asked: string[] = [];

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

  async inquire(_account: GatewayAccount, ref: string): Promise<GatewayInquiry> {
    this.asked.push(ref);
    return this.inquiries.get(ref) ?? { status: 'unknown', message: 'Test gateway was not told' };
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

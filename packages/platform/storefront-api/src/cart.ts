// Carts, as storefronts and the core speak of them (ADR-042): the core keeps each shopper's cart,
// and the storefront changes it for them, as Shopify's cart forms and Ajax cart do, over HTTP with
// the platform's storefront key. Prices are in minor units (paisa), as in storefront documents;
// IDs are the documents' own.

/** Every storefront route of the core starts here, and needs the storefront key. */
export const STOREFRONT_API_PREFIX = '/storefront/';

/** Carries the secret from the shopper's cart cookie, which names their cart. */
export const CART_TOKEN_HEADER = 'x-hatti-cart';

/** What a storefront can do to a cart: Shopify's `/cart/add`, `/cart/change`, and so on. */
export type CartActionName = 'add' | 'change' | 'update' | 'clear';

export const CART_ACTIONS: readonly CartActionName[] = ['add', 'change', 'update', 'clear'];

/** A shop's cart: GET reads it, POST to `…/cart/{action}` changes it. */
export function cartPath(shopId: string, action?: CartActionName): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/cart${action ? `/${action}` : ''}`;
}

/**
 * A shop's checkouts (ADR-044): POST starts one for the cart the `x-hatti-cart` header names;
 * GET and POST `…/checkouts/{secret}` are its page, for the storefront to send on the shop's own
 * address, the POST with the form's fields as JSON.
 */
export function checkoutsPath(shopId: string, token?: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/checkouts${token ? `/${token}` : ''}`;
}

/**
 * Where the storefront opens the shop's payment link `token` (ADR-248): a POST, with the visits
 * that brought the shopper.
 */
export function paymentLinkPath(shopId: string, token: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/payment-links/${token}`;
}

/**
 * The shop's tracking page (ADR-251): GET for its form, POST with what the shopper typed, a
 * {@link TrackingRequest}.
 */
export function trackingPath(shopId: string): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/tracking`;
}

/** What a shopper typed to find their order: its number or a tracking number, and their mobile. */
export interface TrackingRequest {
  reference: string;
  phone: string;
}

/** The tracking page as the core renders it, with the status and headers to send it with. */
export interface TrackingPageResponse {
  status: number;
  headers: Record<string, string>;
  html: string;
}

/**
 * Carry, with the POST that places an order, where the shopper placed it from: the address and
 * `User-Agent` their browser gave the storefront, which the order keeps as what it agreed from
 * (ADR-057).
 */
export const CLIENT_IP_HEADER = 'x-hatti-client-ip';
export const CLIENT_USER_AGENT_HEADER = 'x-hatti-client-user-agent';
/**
 * And the IDs the shop's Meta pixel gave their browser (ADR-144), as a query string:
 * `fbp=…&fbc=…`.
 */
export const CLIENT_BROWSER_IDS_HEADER = 'x-hatti-client-browser-ids';
/**
 * And the token of a number the browser proved with a code at the shop's checkout lately, from
 * its {@link NUMBER_PROOF_COOKIE} (CHK-09, ADR-199).
 */
export const CLIENT_PROOF_HEADER = 'x-hatti-number-proof';

/**
 * The cookie a browser keeps, on the shop's address, of the number it proved with a code at its
 * checkout (ADR-199): HttpOnly, for /checkouts alone, for 30 days.
 */
export const NUMBER_PROOF_COOKIE = 'hatti_proved';

/** The cookie that keeps `proof` in the browser, as a `Set-Cookie` header says it (ADR-199). */
export function numberProofCookie(proof: string, options: { secure: boolean }): string {
  return (
    `${NUMBER_PROOF_COOKIE}=${proof}; Path=/checkouts; Max-Age=${30 * 24 * 3600}; HttpOnly; ` +
    `SameSite=Lax${options.secure ? '; Secure' : ''}`
  );
}

/** Where the shopper placed an order from, as their browser told the storefront. */
export interface CheckoutClient {
  ip: string;
  userAgent: string | null;
  /**
   * The IDs the shop's Meta pixel gave their browser, from its cookies on the shop's address
   * (MKT-10, ADR-144): `fbp` from `_fbp`, its browser ID; `fbc` from `_fbc`, the click on an ad
   * that brought it. Each left out when the browser had none.
   */
  browserIds?: { fbp?: string; fbc?: string };
  /** The token of a number the browser proved lately, from its cookie (ADR-199). */
  proof?: string;
}

/** Where a checkout's page is, on a shop's storefront and on the core's own address alike. */
export function checkoutPagePath(token: string): string {
  return `/checkouts/${token}`;
}

/**
 * Where a shop's catalog feed is on its storefront (ADR-142), which the Admin API gives shops to
 * hand Google Merchant Center and Meta's catalogs.
 */
export const PRODUCT_FEED_PATH = '/feeds/products.xml';

/**
 * A visit to a shop's storefront that brought the shopper (ADR-139), as their browser kept it:
 * when it began, the address it landed on, and the page on another site that linked to it.
 */
export interface StorefrontVisit {
  /** ISO 8601. */
  occurredAt: string;
  landingPage: string;
  referrerUrl: string | null;
}

/**
 * What starting a checkout sends: the visits the storefront knows brought the shopper, the first
 * and the last, which the order placed keeps (ADR-139).
 */
export interface CheckoutStartRequest {
  visits?: StorefrontVisit[];
}

/**
 * Where to send the shopper: the checkout's page, at an address with a secret of its own. A
 * storefront sends them to `path` on the shop's address; `url` is the page on the core's.
 */
export interface CheckoutStartResponse {
  path: string;
  url: string;
}

/**
 * A checkout's page as the core renders it, with the status and headers to send it with; or, when
 * a POST placed the order or found it placed, `placed`: the shopper is sent to the page again,
 * with GET, so that reloading it does not post again; or, when a POST asked to pay online,
 * `redirect`: where to send the shopper with a 303, the shop's payment gateway (ADR-152).
 */
export type CheckoutPageResponse =
  /** With `proof`, once its number was proved by a code: for the browser's cookie (ADR-199). */
  | { placed: true; proof?: string }
  | { placed: false; redirect: string }
  | { placed: false; status: number; headers: Record<string, string>; html: string };

/**
 * What opening a payment link (ADR-248) comes to: where to send the shopper, a checkout of their
 * own with the link's items; or the page saying why there is none, with its status and headers.
 */
export type PaymentLinkOpenResponse =
  CheckoutStartResponse | { status: number; headers: Record<string, string>; html: string };

/** A line of the cart: by its key, by its variant (the first line with it), or by place, from 1. */
export type LineRef = { key: string } | { variantId: string } | { index: number };

export interface CartItemInput {
  variantId: string;
  /** 1 unless given. */
  quantity?: number;
  /** What the shopper gave for this line, such as a name to embroider; a name starting `_` is hidden. */
  properties?: Record<string, string>;
}

/** Adds each item to the line with its variant and properties, or as a new line, first. */
export interface CartAddBody {
  items: CartItemInput[];
}

/** Sets a line's quantity, 0 taking it out, or its properties. */
export interface CartChangeBody {
  line: LineRef;
  quantity?: number;
  properties?: Record<string, string>;
}

/**
 * Sets lines' quantities, a variant the cart lacks being added; the note; attributes, an empty
 * value taking one away; and, as Shopify's `discount`, the discount code: the first of those
 * given, separated by commas, that a shop could have, an empty one taking the code off.
 */
export interface CartUpdateBody {
  updates?: { line: LineRef; quantity: number }[];
  note?: string;
  attributes?: Record<string, string>;
  discount?: string;
}

/** Takes every line out; the note and attributes stay. */
export type CartClearBody = Record<string, never>;

export interface CartBodies {
  add: CartAddBody;
  change: CartChangeBody;
  update: CartUpdateBody;
  clear: CartClearBody;
}

/** A line of the cart, priced as the catalog prices its variant now. */
export interface CartLineJson {
  /** The line's variant and properties: a line is added to when both match. */
  key: string;
  variantId: string;
  productId: string;
  quantity: number;
  properties: Record<string, string>;
  /** Each, and for the line. */
  price: number;
  linePrice: number;
  /** The product's title, and the variant's, such as "Red / M" or "Default Title". */
  title: string;
  variantTitle: string;
  sku: string | null;
  /** Each; 0 when not known. */
  grams: number;
  /** Whether its price includes the shop's sales tax, as Shopify's cart has it. */
  taxable: boolean;
  /** Its variant's tax code, naming one of the shop's tax categories; null for none. */
  taxCode: string | null;
  /**
   * The most the line can have now, when that is fewer than its quantity, as when stock ran out
   * after it was added; null while all of it can be bought.
   */
  maxQuantity: number | null;
}

export interface CartJson {
  note: string;
  attributes: Record<string, string>;
  /** The newest line first. Lines whose product is gone or no longer for sale are left out. */
  items: CartLineJson[];
  itemCount: number;
  subtotal: number;
  totalWeightGrams: number;
  /** The discount code the shopper applied, if any. */
  discount: CartDiscountJson | null;
  /** What the code takes off the items now; delivery's part is checkout's. */
  totalDiscount: number;
}

/**
 * The discount code a cart keeps, and what it takes off the items now (ADR-063). Of a code that
 * does not apply, it says only that, as Shopify's cart does, whether or not the shop has it:
 * checkout says why, and counts the codes tried there.
 */
export interface CartDiscountJson {
  /** As the shop wrote it, when it applies; else as typed. */
  code: string;
  /** Whether the code applies to the cart as it is now. */
  applicable: boolean;
  /** What the code gives, when it applies. */
  kind: 'percentage' | 'fixed_amount' | 'free_shipping' | null;
  /** The percentage off, such as 12.5, or the amount off in paisa; 0 for free delivery. */
  value: number;
  /** Off the items now, in paisa; 0 for free delivery, which checkout takes off. */
  amount: number;
}

/** GET: the cart, or null when the token names none, as after it expired. */
export interface CartReadResponse {
  cart: CartJson | null;
}

/**
 * POST: the cart after the action, with its token, the one sent or a new cart's; null while
 * there is no cart, as after clearing none. `added` has the keys of the lines an `add` added to,
 * in its items' order.
 */
export interface CartChangeResponse {
  cart: CartJson;
  token: string | null;
  added: string[];
}

/** Why an action was refused (422); the cart is as it was. */
export type CartError =
  /** The request is not one the storefront should have sent. */
  | { code: 'INVALID'; message: string }
  /** No variant of the shop's with this ID is for sale. */
  | { code: 'NOT_FOUND'; variantId: string }
  /** The cart has no such line. */
  | { code: 'LINE_NOT_FOUND' }
  /**
   * More than can be bought: at most `max` of the variant across its lines, 0 when it is sold out,
   * or on one line, as many as an order's line takes.
   */
  | { code: 'MAX_QUANTITY'; variantId: string; title: string; max: number }
  /** A cart has at most `max` lines. */
  | { code: 'MAX_LINES'; max: number }
  /** No checkout for a cart with nothing that can be ordered, or none at all. */
  | { code: 'EMPTY' };

export interface CartErrorResponse {
  error: CartError;
}

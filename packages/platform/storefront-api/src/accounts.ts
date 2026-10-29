// Shoppers' accounts on a shop's storefront (CUS-02, ADR-570), as Shopify's customer accounts: a
// shopper signs in with their mobile number and a one-time code the core sends it, on WhatsApp or
// by SMS, and the core gives the storefront a session's secret for the browser's cookie, through
// which it reads their account: their orders with the shop and their store credit. The secret is
// the only credential; the storefront sends it in `x-hatti-account`, never in an address. Signed
// in, a shopper asks for the file of their own data, or for its erasure (ADR-572), and their
// wishlist is kept with their account, as well as in their browser (ADR-575).

import { STOREFRONT_API_PREFIX } from './cart.js';

/** Carries the secret from the shopper's account cookie, which names their session. */
export const ACCOUNT_TOKEN_HEADER = 'x-hatti-account';

/**
 * The cookie a browser keeps, on the shop's address, of the session it signed in to (ADR-570):
 * HttpOnly, for the whole address, for 90 days, the longest a session lasts; the core ends one
 * sooner, 30 days after it was last used, or when its shopper signs out.
 */
export const ACCOUNT_COOKIE = 'hatti_account';

const ACCOUNT_COOKIE_SECONDS = 90 * 24 * 3600;

/** The cookie that keeps `token` in the browser, as a `Set-Cookie` header says it. */
export function accountCookie(token: string, options: { secure: boolean }): string {
  return (
    `${ACCOUNT_COOKIE}=${token}; Path=/; Max-Age=${ACCOUNT_COOKIE_SECONDS}; HttpOnly; ` +
    `SameSite=Lax${options.secure ? '; Secure' : ''}`
  );
}

/** The `Set-Cookie` header that takes the cookie away, once the shopper signs out. */
export function accountCookieCleared(options: { secure: boolean }): string {
  return `${ACCOUNT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

/** What a storefront asks of a shop's accounts, each under `…/account`. */
export type AccountRoute =
  | 'login'
  | 'login/verify'
  | 'session'
  | 'logout'
  | 'data/export'
  | 'data/erase'
  | 'wishlist'
  | 'addresses'
  | 'prices';

/**
 * A shop's accounts: GET `…/account` reads the account of the session `x-hatti-account` names;
 * POST `…/account/login` sends a code, POST `…/account/login/verify` checks it and signs in, GET
 * `…/account/session` reads the session, and POST `…/account/logout` ends it. POST
 * `…/account/data/export` makes the shopper's file, or gives the one kept, and GET links to the
 * one kept, an {@link AccountDataExportResponse}; POST `…/account/data/erase` asks for their
 * erasure, an {@link AccountDataEraseResponse} (ADR-572). GET `…/account/wishlist` reads the
 * account's wishlist and POST adds to it, an {@link AccountWishlistResponse} (ADR-575). GET
 * `…/account/addresses` reads the account's address book and POST adds to it, an
 * {@link AccountAddressesResponse} (ADR-583). GET `…/account/prices?variants=…` reads what the
 * shopper's price lists make one of each variant cost, an {@link AccountPricesResponse} (ADR-781).
 * Each is 404 without a session.
 */
export function accountPath(shopId: string, route?: AccountRoute): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/account${route ? `/${route}` : ''}`;
}

/** POST: the page of one of the account's orders, an {@link AccountOrderLinkResponse}. */
export function accountOrderLinkPath(shopId: string, orderId: string): string {
  return `${accountPath(shopId)}/orders/${orderId}/link`;
}

/** DELETE: takes the product `productId` off the account's wishlist (ADR-575). */
export function accountWishlistItemPath(shopId: string, productId: string): string {
  return `${accountPath(shopId, 'wishlist')}/${productId}`;
}

/** PUT changes, and DELETE takes away, the address `addressId` of the account's book (ADR-583). */
export function accountAddressPath(shopId: string, addressId: string): string {
  return `${accountPath(shopId, 'addresses')}/${addressId}`;
}

/** The most addresses an account's book keeps (ADR-583). */
export const ACCOUNT_ADDRESSES_MAX = 20;

/**
 * The most products an account's wishlist keeps (ADR-575): adding more, the oldest go to make room,
 * as many as one request may add.
 */
export const ACCOUNT_WISHLIST_MAX = 100;

/** What a shopper typed to sign in, and how they asked for the code. */
export interface AccountLoginStartRequest {
  /** A Pakistani mobile number, as typed. */
  phone: string;
  /** WhatsApp unless given. */
  channel?: 'whatsapp' | 'sms';
  /** The storefront's language, for the code's message: "en" or "ur"; the shop's unless given. */
  locale?: string;
}

/**
 * A code sent to the number, `sent`, or none, `too_many`, as the number or the address it was
 * asked from was sent as many as it may be for now. The same whether or not the number is one of
 * the shop's customers', so that no one learns from it who shops there.
 */
export interface AccountLoginStartResponse {
  state: 'sent' | 'too_many';
  /** The number, masked for the page to say where the code went: "0300 ••••567". */
  phone: string;
  channel: 'whatsapp' | 'sms';
}

/** What was wrong with what was typed (422), by field: "phone". */
export interface AccountErrorResponse {
  errors: { field: string; message: string }[];
}

/** The number the code went to, as typed again, and the code typed. */
export interface AccountLoginVerifyRequest {
  phone: string;
  code: string;
}

/**
 * Signed in: the session's secret, for the browser's cookie, given only now, and the session.
 * The core keeps only its digest.
 */
export interface AccountLoginVerifyResponse {
  token: string;
  session: AccountSessionJson;
}

/**
 * Why the code did not sign in (422): `wrong`, with tries left; `expired`, its ten minutes up or
 * none sent; `too_many`, its tries used up, for a new code to be asked for; `invalid`, not a
 * mobile number.
 */
export interface AccountLoginVerifyErrorResponse {
  error: 'wrong' | 'expired' | 'too_many' | 'invalid';
}

/** A signed-in session. */
export interface AccountSessionJson {
  /** E.164: the number the shopper proved. */
  phone: string;
  /** The name the shop has for its customer; null for none, or a number no customer has. */
  name: string | null;
  /** ISO 8601: when it signed in, and when it ends unless used again before. */
  signedInAt: string;
  expiresAt: string;
}

/** GET `…/account/session`: the session, or null once it is none: ended, expired or unknown. */
export interface AccountSessionResponse {
  session: AccountSessionJson | null;
}

/** An order of the shopper's, as their account lists it. */
export interface AccountOrderJson {
  /** The order's public ID, "ord_…", for {@link accountOrderLinkPath}. */
  id: string;
  /** "#1001". */
  name: string;
  /** ISO 8601. */
  placedAt: string;
  status: 'open' | 'closed' | 'cancelled';
  financialStatus:
    | 'pending'
    | 'authorized'
    | 'paid'
    | 'partially_paid'
    | 'partially_refunded'
    | 'refunded'
    | 'voided';
  fulfillmentStatus:
    'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'returned' | 'partially_returned';
  /** Minor units (paisa), in `currency`. */
  total: number;
  currency: string;
  /** Units of everything it has. */
  itemCount: number;
  /**
   * Whether it has a page to open, through {@link accountOrderLinkPath}: while it is open, and for
   * 30 days after it closed; never once cancelled.
   */
  hasPage: boolean;
  /**
   * What it had, to buy again (ADR-574), in its order: a bundle once, as its own variant, rather
   * than its parts; gift cards left out. At most 100 of its lines are read.
   */
  lines: AccountOrderLineJson[];
}

/** An order of the shopper's from the store the shop moved from (ADR-786), as it was there. */
export interface AccountPastOrderJson {
  /** "pord_…". */
  id: string;
  /** Its name there, "#1001". */
  name: string;
  /** ISO 8601. */
  placedAt: string;
  cancelled: boolean;
  /** The store's words, lower case: "paid", "refunded"; null for none. */
  financialStatus: string | null;
  /** The store's words, lower case: "fulfilled", "unfulfilled"; null for none. */
  fulfillmentStatus: string | null;
  /** Minor units, in `currency`. */
  total: number;
  currency: string;
  /** Units of everything it had. */
  itemCount: number;
  lines: { title: string; variantTitle: string | null; quantity: number }[];
}

/** A line of an order of the shopper's, as their account offers it again (ADR-574). */
export interface AccountOrderLineJson {
  /**
   * The variant to put in the cart, as carts name them (the storefront's documents' UUIDs); a
   * bundle's own. Null for a bundle the shop no longer has as it was sold.
   */
  variantId: string | null;
  /** As it was sold: the product's title, a bundle's own. */
  productTitle: string;
  /** "M / Red", as it was sold; null for a product without options, or a bundle. */
  variantTitle: string | null;
  /** As many as the order had. */
  quantity: number;
  /**
   * Whether it can be put in the cart now: its variant is still the shop's, its product on sale
   * and not sold out (a bundle, by its parts' stock).
   */
  available: boolean;
}

/**
 * The file of the shopper's own data (ADR-572), as the shop's staff can give it them (ADR-102):
 * made when they ask, at most once a day, and kept until `expiresAt`, a day on, the same file
 * given again until then. It downloads through a link that lasts minutes, which
 * {@link accountPath}'s `data/export` gives each time.
 */
export interface AccountDataExportJson {
  state: 'ready';
  /** ISO 8601: when it was made. */
  readyAt: string;
  /** ISO 8601: when storage lets it go, and another may be made. */
  expiresAt: string;
}

/**
 * The shopper's erasure, asked for by them or by the shop for them, waiting to happen (ADR-110):
 * `waiting` until `eraseAfter`, unless the shop cancels it first; `held` while something of
 * theirs is still under way, an order open or store credit the shop owes them, which it waits
 * for, past `eraseAfter` if need be.
 */
export interface AccountErasureJson {
  state: 'waiting' | 'held';
  /** ISO 8601: when it was asked for. */
  requestedAt: string;
  /** ISO 8601: the soonest it happens. */
  eraseAfter: string;
}

/** What the shopper asked of their own data (ADR-572), for their account page to say. */
export interface AccountDataRequestsJson {
  /**
   * Whether the shop keeps them as a customer, with data to give or erase; false for a number
   * no customer has.
   */
  available: boolean;
  /** Days an erasure waits once asked for, while the shop can still cancel it. */
  erasureWaitDays: number;
  /** Their file kept; null while none is. */
  export: AccountDataExportJson | null;
  /** Their erasure waiting; null while none is. */
  erasure: AccountErasureJson | null;
}

/**
 * A change of a shopper's store credit (ADR-668): given (`credit`), spent on an order (`debit`),
 * given back as the order it paid was cancelled (`debit_revert`), or ended unspent
 * (`expiration`).
 */
export interface AccountStoreCreditEntryJson {
  kind: 'credit' | 'debit' | 'debit_revert' | 'expiration';
  /** Why: by the shop's hand, a refund, an order it paid, or one cancelled; null for an expiry. */
  event: 'adjustment' | 'order_refund' | 'order_payment' | 'order_cancellation' | null;
  /** Minor units, signed: more than 0 given, less than 0 taken. */
  amount: number;
  /** Minor units: what they had after it. */
  balanceAfter: number;
  /** ISO 8601. */
  at: string;
  /** ISO 8601: when a credit expires; null for one that never does, and for the others. */
  expiresAt: string | null;
  /** The order it paid or came back from, by its public ID as the account's orders name it. */
  orderId: string | null;
}

/** A shopper's code to bring friends, while the shop's referral programme is on (ADR-809). */
export interface AccountReferralJson {
  /** What their link carries after `?invite=`. */
  code: string;
  /** Minor units: what they are given once a friend's first order arrives, and the friend. */
  referrerCredit: number;
  friendCredit: number;
  currency: string;
}

/**
 * A subscription of the shopper's (CAT-16, ADR-916): what its orders hold and how often, and its
 * latest order, whose page skips its next order, pauses, resumes or cancels it.
 */
export interface AccountSubscriptionJson {
  id: string;
  status: 'active' | 'paused';
  /** As the shop named its plan then: "Subscribe & save". */
  planName: string;
  interval: { unit: 'week' | 'month'; count: number };
  /** Off each order's items, in percent. */
  discountPercent: number;
  /** YYYY-MM-DD in Pakistan's time: when its next order is placed, while it is active. */
  nextOrderOn: string;
  ordersPlaced: number;
  lines: { productTitle: string; variantTitle: string | null; quantity: number }[];
  /** Its latest order, which `…/account/orders/{id}` opens to manage it. */
  orderId: string;
}

/** A shopper's account with the shop. */
export interface AccountJson {
  /** E.164: the number they signed in with, whole, as it is theirs. */
  phone: string;
  /** The name the shop has for them; null for none. */
  name: string | null;
  /**
   * Their latest orders with the shop, the newest first, at most 20: those of the customer the
   * number is now, with the numbers merged into them. None for a number no customer has.
   */
  orders: AccountOrderJson[];
  /**
   * Their latest orders from the store the shop moved from (ADR-786), the newest first, at most
   * 20: kept to look back on, with no page and nothing to buy again. Absent from older cores.
   */
  pastOrders?: AccountPastOrderJson[];
  /** Their store credit in the shop's currency: what they have, and what of it expires soonest. */
  storeCredit: {
    /** Minor units. */
    balance: number;
    currency: string;
    /** Null while none of it expires. */
    expiring: { amount: number; expiresAt: string } | null;
    /** Its latest changes, the newest first, at most 20 (ADR-668); absent from older cores. */
    history?: AccountStoreCreditEntryJson[];
  };
  /** Their file, and their erasure, as they asked for them (ADR-572). */
  dataRequests: AccountDataRequestsJson;
  /**
   * Their code to bring friends (ADR-809): null while the shop's referral programme is off, or
   * for a number no customer has; absent from older cores.
   */
  referral?: AccountReferralJson | null;
  /** Their subscriptions not cancelled, the newest first, at most 20 (ADR-916); absent from older cores. */
  subscriptions?: AccountSubscriptionJson[];
}

/** GET `…/account`: the account, or null when the session is none. */
export interface AccountResponse {
  account: AccountJson | null;
}

/**
 * POST `…/account/orders/{id}/link`: the order's page, on the core's own address, `url`, and its
 * path there, "/o/…"; 404 for an order of no one signed in, or with no page.
 */
export interface AccountOrderLinkResponse {
  path: string;
  url: string;
}

/**
 * POST `…/account/data/export` (ADR-572): the shopper's file, `ready`, with a link that downloads
 * it for a few minutes, `url`, `made` now or the one kept given again; `none` for a number no
 * customer has, of whom the shop keeps nothing to give. GET gives the file kept the same way, or
 * 404 for none.
 */
export type AccountDataExportResponse =
  (AccountDataExportJson & { made: boolean; url: string }) | { state: 'none' };

/**
 * POST `…/account/data/erase` (ADR-572): the shopper's erasure, asked for now or before, as it
 * waits; `none` for a number no customer has, of whom the shop keeps nothing to erase.
 */
export type AccountDataEraseResponse = AccountErasureJson | { state: 'none' };

/**
 * POST `…/account/wishlist` (ADR-575): products to add to the account's wishlist, by the catalog's
 * IDs as the storefront's documents name them, the newest first, as the browser keeps its own: at
 * most {@link ACCOUNT_WISHLIST_MAX}. Those already in it stay where they are, and those the shop
 * does not have are left out. 422 for a list that is not one of strings, or too long.
 */
export interface AccountWishlistAddRequest {
  productIds: string[];
}

/**
 * The account's wishlist (ADR-575): its products, the newest first, at most
 * {@link ACCOUNT_WISHLIST_MAX}, by the catalog's IDs as the storefront's documents name them;
 * those the shop no longer has left out. Each of GET, POST and DELETE answers it, as it is now.
 */
export interface AccountWishlistResponse {
  productIds: string[];
}

/** The most variants `…/account/prices` is asked of at once: a product's, as the catalog keeps. */
export const ACCOUNT_PRICES_MAX = 100;

/**
 * What one of each variant asked of costs the shopper signed in, in minor units (CUS-06,
 * ADR-781): only those their price lists make lower than the price to anyone, by the catalog's
 * IDs; a variant left out costs what it costs anyone.
 */
export interface AccountPricesResponse {
  prices: Record<string, number>;
}

/**
 * An address in the account's book (CUS-02, ADR-583), as checkout keeps a shipping address: its
 * number in E.164, its city spelled the standard way, and its province's code.
 */
export interface AccountAddress {
  id: string;
  name: string;
  phone: string;
  address1: string;
  address2: string | null;
  landmark: string | null;
  city: string;
  provinceCode: string | null;
  /** The province's name, in English: "Punjab". */
  province: string | null;
  zip: string | null;
  /** The one the account delivers to first; one of them while it has any. */
  default: boolean;
}

/**
 * POST `…/account/addresses`, or PUT `…/account/addresses/{id}` (ADR-583): an address as typed,
 * checked as checkout's are; `default` makes it the one delivered to first. 422 with an
 * {@link AccountErrorResponse} for one that will not do, for a book full at
 * {@link ACCOUNT_ADDRESSES_MAX}, or for a number no customer has yet, whose addresses come with
 * their first order.
 */
export interface AccountAddressRequest {
  name: string;
  phone: string;
  address1: string;
  address2?: string | null;
  landmark?: string | null;
  city: string;
  province?: string | null;
  zip?: string | null;
  default?: boolean;
}

/**
 * The account's address book (ADR-583): the default first, then the latest changed. Each of GET,
 * POST, PUT and DELETE answers it, as it is now; empty for a number no customer has yet.
 */
export interface AccountAddressesResponse {
  addresses: AccountAddress[];
}

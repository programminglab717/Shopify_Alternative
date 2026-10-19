// Shoppers' accounts on a shop's storefront (CUS-02, ADR-570), as Shopify's customer accounts: a
// shopper signs in with their mobile number and a one-time code the core sends it, on WhatsApp or
// by SMS, and the core gives the storefront a session's secret for the browser's cookie, through
// which it reads their account: their orders with the shop and their store credit. The secret is
// the only credential; the storefront sends it in `x-hatti-account`, never in an address. Signed
// in, a shopper asks for the file of their own data, or for its erasure (ADR-572).

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
  'login' | 'login/verify' | 'session' | 'logout' | 'data/export' | 'data/erase';

/**
 * A shop's accounts: GET `…/account` reads the account of the session `x-hatti-account` names;
 * POST `…/account/login` sends a code, POST `…/account/login/verify` checks it and signs in, GET
 * `…/account/session` reads the session, and POST `…/account/logout` ends it. POST
 * `…/account/data/export` makes the shopper's file, or gives the one kept, and GET links to the
 * one kept, an {@link AccountDataExportResponse}; POST `…/account/data/erase` asks for their
 * erasure, an {@link AccountDataEraseResponse} (ADR-572). Each is 404 without a session.
 */
export function accountPath(shopId: string, route?: AccountRoute): string {
  return `${STOREFRONT_API_PREFIX}shops/${shopId}/account${route ? `/${route}` : ''}`;
}

/** POST: the page of one of the account's orders, an {@link AccountOrderLinkResponse}. */
export function accountOrderLinkPath(shopId: string, orderId: string): string {
  return `${accountPath(shopId)}/orders/${orderId}/link`;
}

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
  /** Their store credit in the shop's currency: what they have, and what of it expires soonest. */
  storeCredit: {
    /** Minor units. */
    balance: number;
    currency: string;
    /** Null while none of it expires. */
    expiring: { amount: number; expiresAt: string } | null;
  };
  /** Their file, and their erasure, as they asked for them (ADR-572). */
  dataRequests: AccountDataRequestsJson;
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

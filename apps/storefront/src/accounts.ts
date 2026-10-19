// Shoppers' accounts on the storefront (CUS-02, ADR-571), as Shopify's customer accounts: the
// shop's sign-in page asks for a mobile number, the core sends a code to it, and the code typed
// signs the shopper in, the session's secret kept in a cookie only the server reads (ADR-570).
// Their account page lists their orders with the shop and their store credit, from `customer`,
// and from it they ask for the file of their own data, or for its erasure (ADR-572).
// Pages are kept at the edge and are the same for every shopper, so only the account's own pages,
// never kept, read the session; the others learn that a shopper is signed in from a cookie their
// scripts read, which says nothing more.

import {
  ACCOUNT_COOKIE,
  type AccountJson,
  type AccountLoginVerifyErrorResponse,
  type AccountOrderJson,
} from '@hatti/storefront-api';
import { cookieOf } from './cart.js';

/**
 * The cookie keeping the number a code was sent to while the shopper types it: as they typed it,
 * for the core to check the code against, where the code went, masked, and how. HttpOnly, for ten
 * minutes, as long as a code lasts.
 */
export const LOGIN_COOKIE = 'hatti_login';

const LOGIN_COOKIE_SECONDS = 10 * 60;

/**
 * Whether the shopper is signed in, for pages' scripts: the header's link says "Account" rather
 * than "Sign in". It holds nothing but `1`, and lasts as long as the session's cookie may.
 */
export const SIGNED_IN_COOKIE = 'hatti_signed_in';

const SIGNED_IN_SECONDS = 90 * 24 * 3600;

/** A session's secret, as the core makes them; anything else in the cookie is not sent to it. */
const ACCOUNT_TOKEN = /^[\w-]{16,128}$/;

/** The longest number a shopper's typing is kept of, as the core reads it. */
export const PHONE_TYPED_MAX = 40;

/** The longest code read of what a shopper typed. */
export const CODE_TYPED_MAX = 20;

/** The session's secret the request's cookie keeps; null for none, or one that cannot be one. */
export function accountTokenOf(cookies: string | undefined): string | null {
  const token = cookieOf(cookies, ACCOUNT_COOKIE);
  return token !== null && ACCOUNT_TOKEN.test(token) ? token : null;
}

/** A code on its way: the number as typed, where it went, masked, and how it was sent. */
export interface PendingLogin {
  phone: string;
  masked: string;
  channel: 'whatsapp' | 'sms';
}

/** The cookie that keeps `pending` while the shopper types the code. */
export function loginCookie(pending: PendingLogin, options: { secure: boolean }): string {
  const value = Buffer.from(JSON.stringify(pending)).toString('base64url');
  return (
    `${LOGIN_COOKIE}=${value}; Path=/; Max-Age=${LOGIN_COOKIE_SECONDS}; HttpOnly; ` +
    `SameSite=Lax${options.secure ? '; Secure' : ''}`
  );
}

/** The `Set-Cookie` header that forgets the code on its way, once it is used or gone. */
export function loginCookieCleared(options: { secure: boolean }): string {
  return `${LOGIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

/** The code on its way the request's cookie keeps; null for none, or one not written here. */
export function pendingLoginOf(cookies: string | undefined): PendingLogin | null {
  const value = cookieOf(cookies, LOGIN_COOKIE);
  if (value === null || value.length > 400) return null;
  try {
    const kept = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof kept !== 'object' || kept === null) return null;
    const { phone, masked, channel } = kept as Record<string, unknown>;
    if (typeof phone !== 'string' || phone === '' || phone.length > PHONE_TYPED_MAX) return null;
    if (typeof masked !== 'string' || masked.length > PHONE_TYPED_MAX) return null;
    if (channel !== 'whatsapp' && channel !== 'sms') return null;
    return { phone, masked, channel };
  } catch {
    return null;
  }
}

/** The cookie that tells pages' scripts the shopper is signed in. */
export function signedInCookie(options: { secure: boolean }): string {
  return (
    `${SIGNED_IN_COOKIE}=1; Path=/; Max-Age=${SIGNED_IN_SECONDS}; ` +
    `SameSite=Lax${options.secure ? '; Secure' : ''}`
  );
}

/** The `Set-Cookie` header that tells them the shopper is not, once they sign out. */
export function signedInCookieCleared(options: { secure: boolean }): string {
  return `${SIGNED_IN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

/**
 * The sign-in page's form, as the route leaves it (`form` in `{% form 'customer_login' %}`): the
 * number asked for, or the code sent to it; what was wrong with what was typed, in the page's
 * language; and where to go once signed in.
 */
export interface LoginForm {
  step: 'phone' | 'code';
  /** What the shopper typed, shown again on the number's step; never on the code's. */
  phone: string;
  /** Where the code went, masked: "0300 ••••567"; empty on the number's step. */
  phoneMasked: string;
  channel: 'whatsapp' | 'sms';
  errors: string[];
  /** A path on the shop, or null for the account page. */
  returnTo: string | null;
}

/** Why a sign-in did not go on, as the page says it. */
export type LoginProblem =
  | 'invalid_phone'
  | 'too_many_codes'
  | 'too_many_requests'
  | AccountLoginVerifyErrorResponse['error'];

/** The theme's words for why a sign-in did not go on, and the English they fall back to. */
export function loginErrorMessage(
  problem: LoginProblem,
  translate: (key: string, values: Record<string, unknown>) => string | null,
): string {
  const say = (key: string, english: string) =>
    translate(`customer.login.errors.${key}`, {}) ?? english;
  switch (problem) {
    case 'invalid':
    case 'invalid_phone':
      return say('invalid_phone', 'Enter a Pakistani mobile number, like 0300 1234567.');
    case 'too_many_codes':
      return say(
        'too_many_codes',
        'We have sent this number as many codes as we can for now. Please try again later.',
      );
    case 'too_many_requests':
      return say('too_many_requests', 'Too many tries. Please wait a minute and try again.');
    case 'wrong':
      return say('wrong', 'That code is not right. Check it and try again.');
    case 'expired':
      return say('expired', 'That code has expired. Ask for a new one.');
    case 'too_many':
      return say('too_many_tries', 'That code was tried too many times. Ask for a new one.');
  }
}

/**
 * What the account page says of what a shopper just asked of their own data (ADR-572), named in
 * its address, `?data_request=export_ready`, so that it comes back to the page saying it.
 */
export const DATA_NOTICES = [
  'export_ready',
  'export_none',
  'export_gone',
  'erase_requested',
  'erase_none',
  'erase_unconfirmed',
  'too_many_requests',
] as const;

export type DataNotice = (typeof DATA_NOTICES)[number];

/** The notice an account page's address names; null for none, or one not of {@link DATA_NOTICES}. */
export function dataNoticeOf(value: unknown): DataNotice | null {
  return (DATA_NOTICES as readonly unknown[]).includes(value) ? (value as DataNotice) : null;
}

/** The theme's words for a notice of what the shopper asked of their data, or the English. */
export function dataNoticeMessage(
  notice: DataNotice,
  translate: (key: string, values: Record<string, unknown>) => string | null,
): string {
  const say = (english: string) =>
    translate(`customer.account.data.notices.${notice}`, {}) ?? english;
  switch (notice) {
    case 'export_ready':
      return say('Your data is ready. Download it below.');
    case 'export_none':
      return say("We don't keep any data about you yet, so there is nothing to download.");
    case 'export_gone':
      return say('That file is no longer kept. Ask for a new one.');
    case 'erase_requested':
      return say('We have your request to delete your data.');
    case 'erase_none':
      return say("We don't keep any data about you, so there is nothing to delete.");
    case 'erase_unconfirmed':
      return say('Tick the box to say you understand what deleting your data means.');
    case 'too_many_requests':
      return say('Too many tries. Please wait a minute and try again.');
  }
}

type FinancialStatus = AccountOrderJson['financialStatus'];
type FulfillmentStatus = AccountOrderJson['fulfillmentStatus'];

/** What an order's payment and delivery are, as its account page says them, in each language. */
const STATUS_LABELS: Readonly<
  Record<
    string,
    {
      financial: Readonly<Record<FinancialStatus, string>>;
      fulfillment: Readonly<Record<FulfillmentStatus, string>>;
    }
  >
> = {
  en: {
    financial: {
      pending: 'Pending',
      authorized: 'Authorized',
      paid: 'Paid',
      partially_paid: 'Partially paid',
      partially_refunded: 'Partially refunded',
      refunded: 'Refunded',
      voided: 'Voided',
    },
    fulfillment: {
      unfulfilled: 'Unfulfilled',
      partially_fulfilled: 'Partially fulfilled',
      fulfilled: 'Fulfilled',
      returned: 'Returned',
      partially_returned: 'Partially returned',
    },
  },
  ur: {
    financial: {
      pending: 'ادائیگی باقی',
      authorized: 'ادائیگی منظور',
      paid: 'ادا شدہ',
      partially_paid: 'جزوی ادا شدہ',
      partially_refunded: 'جزوی رقم واپس',
      refunded: 'رقم واپس',
      voided: 'کالعدم',
    },
    fulfillment: {
      unfulfilled: 'ابھی روانہ نہیں ہوا',
      partially_fulfilled: 'جزوی روانہ',
      fulfilled: 'روانہ ہو گیا',
      returned: 'واپس',
      partially_returned: 'جزوی واپس',
    },
  },
};

/**
 * Shopify's `customer`, for the account's pages (ADR-571): the shopper's name and number, their
 * orders with the shop, each linking to its page through the storefront while it has one, and
 * their store credit. Money is in paisa, as everywhere in Liquid here; links are under `prefix`,
 * "/ur" for the Urdu pages. Hatti's `data_requests` say what they asked of their own data
 * (ADR-572), with the notice of what they just asked, in the page's language.
 */
export function customerObject(
  account: AccountJson,
  options: {
    locale: string;
    prefix: string;
    notice?: { code: DataNotice; message: string } | null;
  },
): Record<string, unknown> {
  const labels = STATUS_LABELS[options.locale] ?? STATUS_LABELS.en!;
  const name = account.name?.trim() || null;
  const [first = null, ...rest] = name ? name.split(/\s+/) : [];
  const orders = account.orders.map((order) => ({
    id: order.id,
    name: order.name,
    created_at: order.placedAt,
    cancelled: order.status === 'cancelled',
    financial_status: order.financialStatus,
    financial_status_label: labels.financial[order.financialStatus] ?? order.financialStatus,
    fulfillment_status: order.fulfillmentStatus,
    fulfillment_status_label:
      labels.fulfillment[order.fulfillmentStatus] ?? order.fulfillmentStatus,
    total_price: order.total,
    currency: { iso_code: order.currency },
    item_count: order.itemCount,
    url: order.hasPage ? `${options.prefix}/account/orders/${encodeURIComponent(order.id)}` : null,
  }));
  const credit = account.storeCredit;
  const data = account.dataRequests;
  return {
    name,
    first_name: first,
    last_name: rest.length > 0 ? rest.join(' ') : null,
    phone: account.phone,
    email: null,
    has_account: true,
    orders,
    orders_count: orders.length,
    store_credit_account: {
      balance: credit.balance,
      currency: { iso_code: credit.currency },
      // Hatti's: what of it expires soonest, and when.
      expiring: credit.expiring && {
        amount: credit.expiring.amount,
        expires_at: credit.expiring.expiresAt,
      },
    },
    // Hatti's: their own data (ADR-572). Whether the shop keeps any; their file kept, which
    // downloads through the storefront; their erasure waiting, or held; and the days one waits.
    data_requests: {
      available: data.available,
      erasure_wait_days: data.erasureWaitDays,
      export: data.export && {
        state: data.export.state,
        url: `${options.prefix}/account/data/export`,
        ready_at: data.export.readyAt,
        expires_at: data.export.expiresAt,
      },
      erasure: data.erasure && {
        state: data.erasure.state,
        requested_at: data.erasure.requestedAt,
        erase_after: data.erasure.eraseAfter,
      },
      notice: options.notice ?? null,
    },
  };
}

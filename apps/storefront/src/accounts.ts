// Shoppers' accounts on the storefront (CUS-02, ADR-571), as Shopify's customer accounts: the
// shop's sign-in page asks for a mobile number, the core sends a code to it, and the code typed
// signs the shopper in, the session's secret kept in a cookie only the server reads (ADR-570).
// Their account page lists their orders with the shop and their store credit, from `customer`,
// and from it they ask for the file of their own data, or for its erasure (ADR-572), and buy an
// order's items again, which go in their cart (ADR-574). Their address book (ADR-583) has its
// own page, `/account/addresses`, whose forms add, change and take out addresses (ADR-584).
// Pages are kept at the edge and are the same for every shopper, so only the account's own pages,
// never kept, read the session; the others learn that a shopper is signed in from a cookie their
// scripts read, which says nothing more.

import {
  ACCOUNT_ADDRESSES_MAX,
  ACCOUNT_COOKIE,
  type AccountAddress,
  type AccountAddressRequest,
  type AccountErrorResponse,
  type AccountJson,
  type AccountLoginVerifyErrorResponse,
  type AccountOrderJson,
  type AccountOrderLineJson,
  type CartActionResult,
  type CartItemInput,
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

/**
 * What the cart page says of an order bought again (ADR-574), named in its address,
 * `/cart?reorder=partial`: not all of it could go in the cart, or none of it; or, for the page
 * itself, that the address tried too often.
 */
export const REORDER_NOTICES = ['partial', 'none', 'too_many_requests'] as const;

export type ReorderNotice = (typeof REORDER_NOTICES)[number];

/** The notice a cart page's address names; null for none, or one not of {@link REORDER_NOTICES}. */
export function reorderNoticeOf(value: unknown): ReorderNotice | null {
  return (REORDER_NOTICES as readonly unknown[]).includes(value) ? (value as ReorderNotice) : null;
}

/** The theme's words for what came of buying an order again, or the English. */
export function reorderNoticeMessage(
  notice: ReorderNotice,
  translate: (key: string, values: Record<string, unknown>) => string | null,
): string {
  const say = (english: string) => translate(`cart.reorder.${notice}`, {}) ?? english;
  switch (notice) {
    case 'partial':
      return say(
        'Not everything from your order could go in your cart: some of it is sold out, has ' +
          'fewer left, or is no longer for sale.',
      );
    case 'none':
      return say(
        "Your order's items couldn't go in your cart: they're sold out or no longer for sale.",
      );
    case 'too_many_requests':
      return say('Too many tries. Please wait a minute and try again.');
  }
}

/** The fields of an address form, as `address[city]` names them (ADR-584). */
export const ADDRESS_FIELDS = [
  'name',
  'phone',
  'address1',
  'address2',
  'landmark',
  'city',
  'province',
  'zip',
] as const;

/** The longest text read of what a shopper typed in an address's field. */
const ADDRESS_TYPED_MAX = 300;

/**
 * An address form posted to the address book's page that did not go (ADR-584), for the page to
 * show again: which address it changed, or null for a new one; what was typed; and what was wrong,
 * in the page's language.
 */
export interface AddressForm {
  id: string | null;
  values: Readonly<Record<string, string>>;
  errors: readonly string[];
}

/**
 * The address a posted form sends, from Shopify's `address[...]` fields: its name, or its first
 * and last names together, as Shopify's forms have them; ticked `address[default]`, the default.
 */
export function addressRequestOf(posted: Record<string, unknown>): {
  request: AccountAddressRequest;
  values: Record<string, string>;
} {
  const text = (name: string) => {
    const value = posted[name];
    return typeof value === 'string' ? value.slice(0, ADDRESS_TYPED_MAX) : '';
  };
  const name =
    text('name').trim() || [text('first_name').trim(), text('last_name').trim()].join(' ').trim();
  const values: Record<string, string> = Object.fromEntries(
    ADDRESS_FIELDS.map((field) => [field, field === 'name' ? name : text(field)]),
  );
  const optional = (field: string) => values[field]!.trim() || null;
  const ticked = ['1', 'true', 'on'].includes(text('default'));
  return {
    request: {
      name,
      phone: values.phone!,
      address1: values.address1!,
      address2: optional('address2'),
      landmark: optional('landmark'),
      city: values.city!,
      province: optional('province'),
      zip: optional('zip'),
      default: ticked,
    },
    values: { ...values, default: ticked ? '1' : '' },
  };
}

/**
 * What the core found wrong with an address, in the theme's words or the English (ADR-584): a
 * line for each field; for the book as a whole, that it is full, else that it comes with the
 * first order.
 */
export function addressErrorMessages(
  errors: AccountErrorResponse['errors'],
  book: { full: boolean },
  translate: (key: string, values: Record<string, unknown>) => string | null,
): string[] {
  const say = (key: string, english: string, values: Record<string, unknown> = {}) =>
    translate(`customer.addresses.errors.${key}`, values) ?? english;
  const messages = errors.map(({ field }) => {
    switch (field) {
      case '':
        return book.full
          ? say(
              'too_many',
              `You can keep ${ACCOUNT_ADDRESSES_MAX} addresses. Remove one to add another.`,
              { count: ACCOUNT_ADDRESSES_MAX },
            )
          : say('first_order', 'Your addresses are kept once you place your first order.');
      case 'id':
        return say('not_found', 'That address is no longer in your account.');
      case 'name':
        return say('name', 'Enter the name of who receives the order.');
      case 'phone':
        return say('phone', 'Enter a Pakistani mobile number, like 0300 1234567.');
      case 'address1':
        return say('address1', 'Enter the house and street.');
      case 'city':
        return say('city', 'Enter the city.');
      case 'province':
        return say('province', 'Enter a province of Pakistan, like Punjab or Sindh.');
      case 'zip':
        return say('zip', 'Enter a postal code of 5 digits, or leave it empty.');
      default:
        return say('too_long', 'Shorten what you typed.');
    }
  });
  return [...new Set(messages)];
}

/**
 * An address of the book as Shopify's `address` object has it (ADR-584), and Hatti's landmark:
 * its name split into first and last, Pakistan its country, and `url`, which its form posts to.
 */
export function addressObject(address: AccountAddress, prefix: string): Record<string, unknown> {
  const [first = '', ...rest] = address.name.trim().split(/\s+/);
  const street = [address.address1, address.address2].filter(Boolean).join(', ');
  return {
    id: address.id,
    name: address.name,
    first_name: first,
    last_name: rest.join(' '),
    company: null,
    address1: address.address1,
    address2: address.address2 ?? '',
    landmark: address.landmark ?? '',
    street,
    city: address.city,
    province: address.province ?? '',
    province_code: address.provinceCode ?? '',
    zip: address.zip ?? '',
    country: 'Pakistan',
    country_code: 'PK',
    phone: address.phone,
    summary: [street, address.city, address.province].filter(Boolean).join(', '),
    url: `${prefix}/account/addresses/${encodeURIComponent(address.id)}`,
    default: address.default,
  };
}

/**
 * What of an order's `lines` goes in the cart again (ADR-574): those that can be had now, as
 * many as the order had, a variant once.
 */
export function reorderItems(lines: readonly AccountOrderLineJson[]): Required<CartItemInput>[] {
  const items: Required<CartItemInput>[] = [];
  for (const line of lines) {
    if (!line.available || line.variantId === null) continue;
    const same = items.find((item) => item.variantId === line.variantId);
    if (same) same.quantity += line.quantity;
    else items.push({ variantId: line.variantId, quantity: line.quantity, properties: {} });
  }
  return items;
}

/**
 * Puts `items` in the cart through `add`, as `/cart/add` does: all at once, or, should the cart
 * refuse them, as many as it takes. A variant it no longer sells is left out, as is one whose
 * product now asks for what the order did not say (ADR-691); one it has too few of goes in with
 * as many as it has left, besides what the cart has of it, `inCart`. Asks the cart once more for
 * each it refuses, and gives up on a refusal of any other kind, as when it is full. The cart as
 * `add` left it, and whether any were left out or fewer; null when none went in.
 */
export async function addAgain(
  items: readonly Required<CartItemInput>[],
  add: (items: Required<CartItemInput>[]) => Promise<CartActionResult>,
  inCart: (variantId: string) => Promise<number>,
): Promise<{ added: Extract<CartActionResult, { ok: true }> | null; short: boolean }> {
  const left = items.map((item) => ({ ...item }));
  let short = false;
  for (let tries = 0; left.length > 0 && tries <= items.length; tries += 1) {
    const result = await add(left.map((item) => ({ ...item })));
    if (result.ok) return { added: result, short };
    short = true;
    const { error } = result;
    const at =
      error.code === 'MAX_QUANTITY' ||
      error.code === 'NOT_FOUND' ||
      error.code === 'PERSONALISATION'
        ? left.findIndex((item) => item.variantId === error.variantId)
        : -1;
    if (at < 0) break;
    const room = error.code === 'MAX_QUANTITY' ? error.max - (await inCart(error.variantId)) : 0;
    if (room > 0 && room < left[at]!.quantity) left[at]!.quantity = room;
    else left.splice(at, 1);
  }
  return { added: null, short: true };
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
 * "/ur" for the Urdu pages. Each order has its `line_items`, and Hatti's `reorder_url`, which
 * the theme's "Buy again" form posts to (ADR-574), while any of them can be had now. Hatti's
 * `data_requests` say what they asked of their own data (ADR-572), with the notice of what they
 * just asked, in the page's language.
 */
export function customerObject(
  account: AccountJson,
  options: {
    locale: string;
    prefix: string;
    notice?: { code: DataNotice; message: string } | null;
    /** Their address book (ADR-584), the default first. */
    addresses?: readonly AccountAddress[] | null;
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
    // What it sold, as sold: a bundle as itself, gift cards left out; whether each can be had.
    line_items: order.lines.map((line) => ({
      title: line.productTitle,
      variant_title: line.variantTitle,
      quantity: line.quantity,
      available: line.available,
    })),
    reorder_url:
      reorderItems(order.lines).length > 0
        ? `${options.prefix}/account/orders/${encodeURIComponent(order.id)}/reorder`
        : null,
  }));
  // Hatti's: their orders from the store the shop moved from (ADR-786), with no page, as kept.
  const pastOrders = (account.pastOrders ?? []).map((order) => {
    const status = (labelled: Record<string, string>, value: string | null) =>
      value === null ? null : (labelled[value] ?? value.replace(/_/g, ' '));
    return {
      id: order.id,
      name: order.name,
      created_at: order.placedAt,
      cancelled: order.cancelled,
      financial_status: order.financialStatus,
      financial_status_label: status(labels.financial, order.financialStatus),
      fulfillment_status: order.fulfillmentStatus,
      fulfillment_status_label: status(labels.fulfillment, order.fulfillmentStatus),
      total_price: order.total,
      currency: { iso_code: order.currency },
      item_count: order.itemCount,
      line_items: order.lines.map((line) => ({
        title: line.title,
        variant_title: line.variantTitle,
        quantity: line.quantity,
      })),
    };
  });
  const credit = account.storeCredit;
  const data = account.dataRequests;
  const addresses = (options.addresses ?? []).map((each) => addressObject(each, options.prefix));
  return {
    name,
    first_name: first,
    last_name: rest.length > 0 ? rest.join(' ') : null,
    phone: account.phone,
    email: null,
    has_account: true,
    orders,
    orders_count: orders.length,
    past_orders: pastOrders,
    // Their address book (ADR-584), as Shopify's: the default first; and the blank address the
    // form for a new one fills in.
    addresses,
    addresses_count: addresses.length,
    default_address: addresses.find((address) => address.default) ?? null,
    new_address: { id: null, country: 'Pakistan', country_code: 'PK' },
    // Hatti's: whether the book has room for another.
    'addresses_full?': addresses.length >= ACCOUNT_ADDRESSES_MAX,
    store_credit_account: {
      balance: credit.balance,
      currency: { iso_code: credit.currency },
      // Hatti's: what of it expires soonest, and when.
      expiring: credit.expiring && {
        amount: credit.expiring.amount,
        expires_at: credit.expiring.expiresAt,
      },
      // Hatti's: its latest changes, the newest first (ADR-668), each with the order it paid
      // or came back from where the account lists it.
      transactions: (credit.history ?? []).map((entry) => {
        const order = entry.orderId ? orders.find((each) => each.id === entry.orderId) : undefined;
        return {
          kind: entry.kind,
          event: entry.event,
          amount: entry.amount,
          balance_after: entry.balanceAfter,
          created_at: entry.at,
          expires_at: entry.expiresAt,
          order: order ? { name: order.name, url: order.url } : null,
        };
      }),
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

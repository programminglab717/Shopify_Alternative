import { createHash } from 'node:crypto';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';

// What an order's moments go to Meta's conversions API as (MKT-10, ADR-143): a server event for
// each, its customer's details normalised and hashed as Meta asks, the ad click that brought
// them, and what they bought, its items named by the variants' IDs, as the catalog feed names
// them (ADR-142).

/** The moments of an order the ad platforms hear of, in the order they come. */
export const CONVERSION_MOMENTS = ['placed', 'confirmed', 'delivered'] as const;
export type ConversionMomentValue = (typeof CONVERSION_MOMENTS)[number];

/**
 * How sending one went: waiting to be sent, or tried again; sent; refused for good; too old for
 * the platform by the time it could go; or not sent at all, as when the shop disconnected.
 */
export const CONVERSION_STATUSES = ['pending', 'sent', 'failed', 'expired', 'skipped'] as const;
export type ConversionStatusValue = (typeof CONVERSION_STATUSES)[number];

/** The platforms a shop connects. */
export const CONVERSION_PLATFORMS = ['meta'] as const;
export type ConversionPlatformValue = (typeof CONVERSION_PLATFORMS)[number];

/** The names a moment goes by when it is not the shop's Purchase. */
const MOMENT_EVENTS: Readonly<Record<ConversionMomentValue, string>> = {
  placed: 'OrderPlaced',
  confirmed: 'OrderConfirmed',
  delivered: 'OrderDelivered',
};

/** What Meta calls a moment: Purchase, at the one the shop chose, else the moment's own name. */
export function metaEventName(
  moment: ConversionMomentValue,
  purchaseAt: ConversionMomentValue,
): string {
  return moment === purchaseAt ? 'Purchase' : MOMENT_EVENTS[moment];
}

const HOUR_MS = 60 * 60_000;

/**
 * How long after a moment it may still go: Meta takes a website event up to seven days after it
 * happened, and refuses a request with one older. An hour is left for the request.
 */
export const META_EVENT_WINDOW_MS = 7 * 24 * HOUR_MS - HOUR_MS;

/** An order as Meta hears of it; the customer's details are hashed on the way. */
export interface ConversionOrder {
  number: number;
  currency: CurrencyCode;
  /** Minor units. */
  total: bigint;
  customerId: string;
  /** In E.164: "+923001234567". */
  phone: string | null;
  email: string | null;
  /** The name on its address: "Ayesha Khan". */
  name: string | null;
  city: string | null;
  zip: string | null;
  clientIp: string | null;
  clientUserAgent: string | null;
  /** The visits that brought its customer, the last first: an ad's click among their addresses. */
  visits: readonly { at: Date; landingPage: string | null }[];
  /**
   * The IDs the shop's Meta pixel gave its customer's browser, from its cookies (ADR-144): its
   * browser ID, `fbp`, and the click on an ad that brought it, `fbc`.
   */
  browserIds: { fbp?: string; fbc?: string } | null;
  lines: readonly { variantId: string; quantity: number; unitPrice: bigint }[];
}

/** A server event, as Meta's conversions API takes it. */
export interface MetaServerEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url: string;
  action_source: 'website';
  user_data: MetaUserData;
  custom_data: {
    currency: string;
    value: number;
    order_id: string;
    content_type: 'product';
    content_ids: string[];
    contents: { id: string; quantity: number; item_price: number }[];
    num_items: number;
  };
}

/** The customer's details as Meta matches them to its people: hashed, but for the browser's. */
export interface MetaUserData {
  ph?: string[];
  em?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  zp?: string[];
  country: string[];
  external_id: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

/**
 * An order's moment as a server event. Its ID is the order's number and the moment, the same
 * however often it is sent, so Meta keeps one. The pixel never sends these: checkout's pages run
 * no scripts (ADR-144).
 */
export function metaEvent(
  order: ConversionOrder,
  conversion: { moment: ConversionMomentValue; occurredAt: Date },
  options: { purchaseAt: ConversionMomentValue; sourceUrl: string },
): MetaServerEvent {
  const amount = (minor: bigint) => Number(toMajorString(money(minor, order.currency)));
  return {
    event_name: metaEventName(conversion.moment, options.purchaseAt),
    event_time: Math.floor(conversion.occurredAt.getTime() / 1000),
    event_id: `order-${order.number}-${conversion.moment}`,
    event_source_url: options.sourceUrl,
    action_source: 'website',
    user_data: metaUserData(order),
    custom_data: {
      currency: order.currency,
      value: amount(order.total),
      order_id: String(order.number),
      content_type: 'product',
      content_ids: [...new Set(order.lines.map((line) => line.variantId))],
      contents: order.lines.map((line) => ({
        id: line.variantId,
        quantity: line.quantity,
        item_price: amount(line.unitPrice),
      })),
      num_items: order.lines.reduce((count, line) => count + line.quantity, 0),
    },
  };
}

/**
 * The customer's details, normalised as Meta's customer information parameters ask and hashed
 * with SHA-256: the mobile number's digits with the country's code, the email in lower case, the
 * first and last names and the city in lower case without punctuation or spaces, the postcode
 * likewise, and the country. Their ID with the shop, hashed too, ties their orders together. The
 * browser's address and user agent, the pixel's ID for it and the ad click's ID go as they are:
 * the click the pixel's cookie kept, or a later one the visits kept, as when the pixel was
 * blocked.
 */
export function metaUserData(order: ConversionOrder): MetaUserData {
  const data: MetaUserData = { country: [hashed('pk')], external_id: [hashed(order.customerId)] };
  const phone = order.phone?.replace(/\D/g, '');
  if (phone) data.ph = [hashed(phone)];
  const email = order.email?.trim().toLowerCase();
  if (email) data.em = [hashed(email)];
  const names = (order.name ?? '')
    .split(/\s+/)
    .map(lettersOf)
    .filter((part) => part !== '');
  if (names.length > 0) data.fn = [hashed(names[0]!)];
  if (names.length > 1) data.ln = [hashed(names.at(-1)!)];
  const city = lettersOf(order.city ?? '');
  if (city) data.ct = [hashed(city)];
  const zip = lettersOf(order.zip ?? '');
  if (zip) data.zp = [hashed(zip)];
  if (order.clientIp) data.client_ip_address = order.clientIp;
  if (order.clientUserAgent) data.client_user_agent = order.clientUserAgent;
  const fbc = laterClick(order.browserIds?.fbc, clickOf(order.visits));
  if (fbc) data.fbc = fbc;
  if (order.browserIds?.fbp) data.fbp = order.browserIds.fbp;
  return data;
}

/** Of click IDs, the later click's, by the time each names; the first of those as late. */
function laterClick(...ids: (string | null | undefined)[]): string | null {
  let later: string | null = null;
  let at = -Infinity;
  for (const id of ids) {
    const when = Number(id?.split('.')[2]);
    if (id && Number.isFinite(when) && when > at) [later, at] = [id, when];
  }
  return later;
}

/**
 * Meta's click ID, `fb.1.{when}.{fbclid}`, from the latest visit whose address had one: what
 * Meta's own cookie would have kept, the click's ID as it was, in its letter case.
 */
export function clickOf(visits: ConversionOrder['visits']): string | null {
  for (const visit of visits) {
    if (!visit.landingPage) continue;
    const query = visit.landingPage.split('#')[0]!.split('?')[1];
    const fbclid = query ? new URLSearchParams(query).get('fbclid') : null;
    if (fbclid) return `fb.1.${visit.at.getTime()}.${fbclid}`;
  }
  return null;
}

/** Text in lower case with nothing but its letters and digits, as Meta compares names. */
function lettersOf(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function hashed(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * When to try again after `attempts` tries: a minute after the first, doubling to six hours, until
 * the moment is too old to go.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 6 * HOUR_MS);
}

import { createHash } from 'node:crypto';
import { money, toMajorString } from '@hatti/money';
import type { ConversionMomentValue, ConversionOrder } from './meta.js';

// What an order's moments go to TikTok's Events API as (MKT-10, ADR-541): a web event for each,
// as Meta's go (ADR-143), its customer's details normalised and hashed as TikTok asks, the ad
// click that brought them, and what they bought, its items named by the variants' IDs, as the
// catalog feed names them (ADR-142).

/** The names a moment goes by when it is not the shop's purchase. */
const MOMENT_EVENTS: Readonly<Record<ConversionMomentValue, string>> = {
  placed: 'PlaceAnOrder',
  confirmed: 'OrderConfirmed',
  delivered: 'OrderDelivered',
};

/**
 * What TikTok calls a moment: CompletePayment, its purchase, at the one the shop chose; else
 * PlaceAnOrder for its placing, and names of their own for the others.
 */
export function tiktokEventName(
  moment: ConversionMomentValue,
  purchaseAt: ConversionMomentValue,
): string {
  return moment === purchaseAt ? 'CompletePayment' : MOMENT_EVENTS[moment];
}

/** A web event, as TikTok's Events API takes it. */
export interface TikTokEvent {
  event: string;
  event_time: number;
  event_id: string;
  user: TikTokUser;
  properties: {
    currency: string;
    value: number;
    order_id: string;
    content_type: 'product';
    contents: { content_id: string; quantity: number; price: number }[];
  };
  page: { url: string };
}

/** The customer's details as TikTok matches them to its people: hashed, but for the browser's. */
export interface TikTokUser {
  external_id: string;
  phone?: string;
  email?: string;
  ip?: string;
  user_agent?: string;
  ttclid?: string;
}

/**
 * An order's moment as a web event. Its ID is the order's number and the moment, as Meta's is,
 * the same however often it is sent, so TikTok keeps one.
 */
export function tiktokEvent(
  order: ConversionOrder,
  conversion: { moment: ConversionMomentValue; occurredAt: Date },
  options: { purchaseAt: ConversionMomentValue; sourceUrl: string },
): TikTokEvent {
  const amount = (minor: bigint) => Number(toMajorString(money(minor, order.currency)));
  return {
    event: tiktokEventName(conversion.moment, options.purchaseAt),
    event_time: Math.floor(conversion.occurredAt.getTime() / 1000),
    event_id: `order-${order.number}-${conversion.moment}`,
    user: tiktokUser(order),
    properties: {
      currency: order.currency,
      value: amount(order.total),
      order_id: String(order.number),
      content_type: 'product',
      contents: order.lines.map((line) => ({
        content_id: line.variantId,
        quantity: line.quantity,
        price: amount(line.unitPrice),
      })),
    },
    page: { url: options.sourceUrl },
  };
}

/**
 * The customer's details, normalised as TikTok's advanced matching asks and hashed with SHA-256:
 * the mobile number in E.164, its plus kept, the email in lower case, and their ID with the shop.
 * The browser's address and user agent go as they are, and the click on TikTok's ad that brought
 * them, from the latest visit whose address had one.
 */
export function tiktokUser(order: ConversionOrder): TikTokUser {
  const user: TikTokUser = { external_id: hashed(order.customerId) };
  const digits = order.phone?.replace(/\D/g, '');
  if (digits) user.phone = hashed(`+${digits}`);
  const email = order.email?.trim().toLowerCase();
  if (email) user.email = hashed(email);
  if (order.clientIp) user.ip = order.clientIp;
  if (order.clientUserAgent) user.user_agent = order.clientUserAgent;
  const click = tiktokClickOf(order.visits);
  if (click) user.ttclid = click;
  return user;
}

/** TikTok's click ID, `ttclid`, from the latest visit whose address had one, as it was. */
export function tiktokClickOf(visits: ConversionOrder['visits']): string | null {
  for (const visit of visits) {
    if (!visit.landingPage) continue;
    const query = visit.landingPage.split('#')[0]!.split('?')[1];
    const ttclid = query ? new URLSearchParams(query).get('ttclid') : null;
    if (ttclid) return ttclid;
  }
  return null;
}

function hashed(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

import { createHash } from 'node:crypto';
import { PublicSite, shopProfile } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { qrCode, toMarkup } from '@hatti/documents';
import { appendEvent } from '@hatti/events';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import {
  FulfillmentService,
  OnlinePayments,
  closeDoorPaymentIn,
  messageLinkIn,
  orderShipmentFactsIn,
  receiveCodIn,
  type OrderShipmentFacts,
} from '@hatti/orders/public';
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Optional,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DELIVERY_COLUMNS,
  RIDER_LIMITS,
  RIDER_LINK,
  RIDER_LINK_PATH,
  RiderEvents,
  toDelivery,
  type DeliveryRecord,
} from './riders.js';

// A rider's page (APP-06, ADR-825): opened from the link of their own, with no account, it lists
// what they carry, each with its address, map, and the customer's number to call or message;
// takes the customer's code and the cash collected as each is delivered, or why not; and says
// what cash they hold. Every answer is private: never cached, indexed, framed or referred.

const digest = (text: string) => createHash('sha256').update(text).digest();

/** Why a delivery was not made, as the rider chooses it. */
export const FAILED_REASONS = {
  not_home: { en: 'No one was home', ur: 'گھر پر کوئی نہیں تھا' },
  refused: { en: 'The customer refused it', ur: 'گاہک نے لینے سے انکار کیا' },
  wrong_address: { en: 'The address could not be found', ur: 'پتا نہیں ملا' },
  no_cash: { en: 'The customer had no cash', ur: 'گاہک کے پاس پیسے نہیں تھے' },
  other: { en: 'Something else', ur: 'کچھ اور' },
} as const;
export type FailedReason = keyof typeof FAILED_REASONS;

export interface RiderStop {
  delivery: DeliveryRecord;
  /**
   * What to collect now: what was due when it was handed out, less what its customer paid online
   * since, at the door (PAY-09, ADR-846).
   */
  due: bigint;
  /** Whether its customer may pay it online at the door: the shop takes payments online. */
  payable: boolean;
  order: string;
  customer: string;
  phone: string | null;
  lines: string[];
  /** Google Maps, at its pin where the customer gave one, else at its address. */
  mapUrl: string | null;
}

export interface RiderPageView {
  shop: string;
  rider: string;
  currency: string;
  stops: RiderStop[];
  /** Today's, in the shop's time zone. */
  delivered: number;
  failed: number;
  cashHeld: bigint;
}

/** Why the page refused what the rider sent. */
export type RiderRefusal = 'none' | 'code' | 'tries' | 'cash';

/** A delivery checked before it is made: refused, or what to record. */
type Checked = { refused: RiderRefusal } | { cash: bigint; codeGiven: boolean; parcel: string };

/** The rider pages' service: their deliveries, found from their links' secrets. */
@Injectable()
export class RiderPageService {
  constructor(
    private readonly db: Database,
    private readonly fulfillments: FulfillmentService,
    /** Where the order's page is, which the rider shows its customer to pay online (ADR-846). */
    @Optional() @Inject(PublicSite) private readonly site?: PublicSite | null,
    /** The shop's gateways; without them, the customer pays the rider in cash alone. */
    @Optional() @Inject(OnlinePayments) private readonly payments?: OnlinePayments | null,
  ) {}

  /** The rider a link's secret names, and their shop: null for none, or one not riding now. */
  async #find(secret: string): Promise<{ shopId: string; riderId: string } | null> {
    if (!RIDER_LINK.test(secret)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; rider_id: string }>(
      sql`SELECT shop_id, rider_id FROM logistics.resolve_rider(${digest(secret)})`,
    );
    return rows[0] ? { shopId: rows[0].shop_id, riderId: rows[0].rider_id } : null;
  }

  /** What the rider's page shows; null for a link that is none. */
  async view(secret: string, at: Date = new Date()): Promise<RiderPageView | null> {
    const found = await this.#find(secret);
    if (!found) return null;
    const { shopId, riderId } = found;
    return this.db.tenant(shopId, async (tx) => {
      const profile = await shopProfile(tx, shopId);
      const { rows: riders } = await tx.execute<{
        name: string;
        delivered: number;
        failed: number;
        cash_held: string;
      }>(sql`
        SELECT r.name,
               (SELECT count(*)::int FROM logistics.rider_deliveries d
                 WHERE d.shop_id = r.shop_id AND d.rider_id = r.id AND d.status = 'delivered'
                   AND (d.delivered_at AT TIME ZONE ${profile.timezone})::date
                       = (${at.toISOString()}::timestamptz AT TIME ZONE ${profile.timezone})::date)
                 AS delivered,
               (SELECT count(*)::int FROM logistics.rider_deliveries d
                 WHERE d.shop_id = r.shop_id AND d.rider_id = r.id AND d.status = 'failed'
                   AND (d.failed_at AT TIME ZONE ${profile.timezone})::date
                       = (${at.toISOString()}::timestamptz AT TIME ZONE ${profile.timezone})::date)
                 AS failed,
               ((SELECT coalesce(sum(d.cash_collected), 0) FROM logistics.rider_deliveries d
                  WHERE d.shop_id = r.shop_id AND d.rider_id = r.id)
                - (SELECT coalesce(sum(h.amount), 0) FROM logistics.rider_handovers h
                    WHERE h.shop_id = r.shop_id AND h.rider_id = r.id))::text AS cash_held
          FROM logistics.riders r
         WHERE r.shop_id = ${shopId} AND r.id = ${riderId}`);
      const rider = riders[0]!;
      const { rows } = await tx.execute<Parameters<typeof toDelivery>[0]>(sql`
        SELECT ${DELIVERY_COLUMNS} FROM logistics.rider_deliveries d
         WHERE d.shop_id = ${shopId} AND d.rider_id = ${riderId} AND d.status = 'out'
         ORDER BY d.created_at, d.id`);
      const online =
        this.site && this.payments
          ? (await this.payments.gatewaysOf(tx, shopId, profile.currency as CurrencyCode)).length >
            0
          : false;
      const stops: RiderStop[] = [];
      for (const delivery of rows.map(toDelivery)) {
        const facts = await orderShipmentFactsIn(tx, shopId, delivery.orderId);
        stops.push(stopOf(delivery, facts, online));
      }
      return {
        shop: profile.name,
        rider: rider.name,
        currency: profile.currency,
        stops,
        delivered: rider.delivered,
        failed: rider.failed,
        cashHeld: BigInt(rider.cash_held),
      };
    });
  }

  /** The rider's delivery `deliveryId`, still out, locked; null for none of theirs. */
  async #outIn(tx: Tx, shopId: string, riderId: string, deliveryId: string) {
    const { rows } = await tx.execute<
      Parameters<typeof toDelivery>[0] & { code_hash: Buffer | null; code_tries: number }
    >(sql`
      SELECT ${DELIVERY_COLUMNS}, d.code_hash, d.code_tries FROM logistics.rider_deliveries d
       WHERE d.shop_id = ${shopId} AND d.rider_id = ${riderId} AND d.id = ${deliveryId}::uuid
         AND d.status = 'out'
         FOR UPDATE`);
    return rows[0] ?? null;
  }

  /**
   * Delivered, as the rider says: with the customer's code where one was sent, though the
   * customer may have lost it, and the cash collected, at most what the order owed. Its parcel is
   * delivered, and the cash received on its order, the rider's to hand over.
   */
  async deliver(
    secret: string,
    deliveryId: string,
    form: { code: string; cash: string },
  ): Promise<{ ok: true } | { refused: RiderRefusal }> {
    const found = await this.#find(secret);
    if (!found || !/^[0-9a-f-]{36}$/.test(deliveryId)) return { refused: 'none' };
    const { shopId, riderId } = found;
    const code = form.code.replace(/\s/g, '');
    const rupees = form.cash.replace(/[,\s]/g, '');
    // Checked first, its tries kept whatever comes after.
    const checked = await this.db.tenant(shopId, async (tx): Promise<Checked> => {
      const delivery = await this.#outIn(tx, shopId, riderId, deliveryId);
      if (!delivery) return { refused: 'none' };
      const due = dueOf(
        BigInt(delivery.cash_due),
        await orderShipmentFactsIn(tx, shopId, delivery.order_id),
      );
      const cash = /^\d{1,9}(\.\d{1,2})?$/.test(rupees)
        ? BigInt(Math.round(Number(rupees) * 100))
        : rupees === ''
          ? 0n
          : null;
      if (cash === null || cash > due) return { refused: 'cash' };
      if (code !== '' && delivery.code_hash) {
        if (delivery.code_tries >= RIDER_LIMITS.codeTries) return { refused: 'tries' };
        if (!digest(code).equals(delivery.code_hash)) {
          await tx.execute(sql`
            UPDATE logistics.rider_deliveries SET code_tries = code_tries + 1
             WHERE shop_id = ${shopId} AND id = ${deliveryId}`);
          return { refused: 'code' };
        }
      }
      return {
        cash,
        codeGiven: code !== '' && delivery.code_hash !== null,
        parcel: delivery.fulfillment_id,
      };
    });
    if ('refused' in checked) return { refused: checked.refused };
    const delivered = await this.fulfillments.markDelivered(
      { shopId, actor: 'system' },
      checked.parcel,
    );
    if (!delivered.ok) return { refused: 'none' };
    await this.db.tenant(shopId, async (tx) => {
      const delivery = await this.#outIn(tx, shopId, riderId, deliveryId);
      if (!delivery) return;
      const { rows } = await tx.execute<{ name: string }>(sql`
        SELECT name FROM logistics.riders WHERE shop_id = ${shopId} AND id = ${riderId}`);
      await tx.execute(sql`
        UPDATE logistics.rider_deliveries
           SET status = 'delivered', delivered_at = now(), cash_collected = ${checked.cash.toString()}::bigint,
               code_given = ${checked.codeGiven}
         WHERE shop_id = ${shopId} AND id = ${deliveryId}`);
      await closeDoorPaymentIn(tx, shopId, delivery.order_id, delivery.fulfillment_id);
      if (checked.cash > 0n) {
        await receiveCodIn(tx, shopId, 'system', {
          orderId: delivery.order_id,
          amount: checked.cash,
          message: `Cash collected by the shop's rider ${rows[0]?.name ?? ''}`.trim(),
        });
      }
      await appendEvent(tx, shopId, {
        type: RiderEvents.DeliveryUpdated,
        aggregateType: 'rider_delivery',
        aggregateId: deliveryId,
        payload: { status: 'delivered', riderId, orderId: delivery.order_id },
      });
    });
    return { ok: true };
  }

  /**
   * The order's page for the rider to show its customer as a QR code, to pay online what they
   * would collect (PAY-09, ADR-846): the one shown before while it works, else a new link, which
   * the order's timeline says went with the rider. Null where there is nothing to pay so, or the
   * shop takes nothing online.
   */
  async doorLink(secret: string, deliveryId: string): Promise<string | null> {
    const found = await this.#find(secret);
    if (!found || !/^[0-9a-f-]{36}$/.test(deliveryId) || !this.site || !this.payments) {
      return null;
    }
    const { shopId, riderId } = found;
    const site = this.site;
    const payments = this.payments;
    return this.db.tenant(shopId, async (tx) => {
      const delivery = await this.#outIn(tx, shopId, riderId, deliveryId);
      if (!delivery) return null;
      const facts = await orderShipmentFactsIn(tx, shopId, delivery.order_id);
      const { currency } = await shopProfile(tx, shopId);
      if (
        dueOf(BigInt(delivery.cash_due), facts) === 0n ||
        (await payments.gatewaysOf(tx, shopId, currency as CurrencyCode)).length === 0
      ) {
        return null;
      }
      const { rows } = await tx.execute<{ door_link: string | null }>(sql`
        SELECT door_link FROM logistics.rider_deliveries
         WHERE shop_id = ${shopId} AND id = ${deliveryId}`);
      const shown = rows[0]?.door_link ?? null;
      const known = shown ? [shown.slice(shown.lastIndexOf('/') + 1)] : [];
      const path = await messageLinkIn(
        tx,
        shopId,
        delivery.order_id,
        'for the rider to show at the door',
        known,
      );
      if (!path) return null;
      if (path !== shown) {
        await tx.execute(sql`
          UPDATE logistics.rider_deliveries SET door_link = ${path}
           WHERE shop_id = ${shopId} AND id = ${deliveryId}`);
      }
      return site.url(path);
    });
  }

  /** Not delivered, as the rider says, and why: its parcel comes back with them. */
  async fail(
    secret: string,
    deliveryId: string,
    reason: string,
  ): Promise<{ ok: true } | { refused: RiderRefusal }> {
    const found = await this.#find(secret);
    if (!found || !/^[0-9a-f-]{36}$/.test(deliveryId)) return { refused: 'none' };
    if (!(reason in FAILED_REASONS)) return { refused: 'none' };
    const { shopId, riderId } = found;
    const parcel = await this.db.tenant(shopId, async (tx) => {
      const delivery = await this.#outIn(tx, shopId, riderId, deliveryId);
      return delivery?.fulfillment_id ?? null;
    });
    if (!parcel) return { refused: 'none' };
    const returning = await this.fulfillments.markReturning({ shopId, actor: 'system' }, parcel);
    if (!returning.ok) return { refused: 'none' };
    await this.db.tenant(shopId, async (tx) => {
      const delivery = await this.#outIn(tx, shopId, riderId, deliveryId);
      if (!delivery) return;
      await tx.execute(sql`
        UPDATE logistics.rider_deliveries
           SET status = 'failed', failed_at = now(),
               failed_reason = ${FAILED_REASONS[reason as FailedReason].en}
         WHERE shop_id = ${shopId} AND id = ${deliveryId}`);
      await closeDoorPaymentIn(tx, shopId, delivery.order_id, delivery.fulfillment_id);
      await appendEvent(tx, shopId, {
        type: RiderEvents.DeliveryUpdated,
        aggregateType: 'rider_delivery',
        aggregateId: deliveryId,
        payload: { status: 'failed', riderId, orderId: delivery.order_id },
      });
    });
    return { ok: true };
  }
}

/**
 * What to collect at the door now: what was due when it was handed out, at most what its order
 * would have collected now, its customer having paid online since (ADR-846).
 */
function dueOf(handedOut: bigint, facts: OrderShipmentFacts | null): bigint {
  if (!facts) return handedOut;
  return facts.codAmount < handedOut ? (facts.codAmount > 0n ? facts.codAmount : 0n) : handedOut;
}

function stopOf(
  delivery: DeliveryRecord,
  facts: OrderShipmentFacts | null,
  online: boolean,
): RiderStop {
  const address = facts?.address ?? null;
  const location = address?.location ?? null;
  const lines = address
    ? [address.address1, address.address2, address.landmark, address.city].filter(
        (line): line is string => Boolean(line),
      )
    : [];
  const mapUrl = location
    ? `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`
    : lines.length > 0
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lines.join(', '))}`
      : null;
  const due = dueOf(delivery.cashDue, facts);
  return {
    delivery,
    due,
    payable: online && due > 0n,
    order: facts?.name ?? '',
    customer: address?.name ?? '',
    phone: address?.phone ?? null,
    lines,
    mapUrl,
  };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const WORDS = {
  title: 'Deliveries · ڈیلیوریز',
  none: 'Nothing to deliver now · ابھی ڈیلیور کرنے کو کچھ نہیں',
  nothing: 'This link is not one of the shop’s riders’ · یہ لنک دکان کے کسی رائیڈر کا نہیں',
  call: 'Call · کال',
  whatsapp: 'WhatsApp',
  map: 'Map · نقشہ',
  collect: (amount: string) => `Collect ${amount} · ${amount} وصول کریں`,
  prepaid: 'Paid already: collect nothing · پہلے سے ادا شدہ: کچھ وصول نہ کریں',
  paidOnline: 'Paid online: collect nothing · آن لائن ادا ہو گیا: کچھ وصول نہ کریں',
  payOnline: 'Customer pays online · گاہک آن لائن ادا کرے',
  scan: (amount: string) =>
    `Ask the customer to scan this and pay ${amount} online, then reload this page · ` +
    `گاہک سے کہیں کہ اسے اسکین کر کے ${amount} آن لائن ادا کرے، پھر یہ صفحہ دوبارہ کھولیں`,
  reload: 'Reload · دوبارہ کھولیں',
  noDoorLink:
    'Nothing to pay online for that delivery now · اس ڈیلیوری کے لیے ابھی آن لائن ادائیگی نہیں',
  code: 'Customer’s code · گاہک کا کوڈ',
  noCode: 'No code was sent: deliver without one · کوئی کوڈ نہیں بھیجا گیا',
  cash: 'Cash collected (Rs) · وصول شدہ رقم (روپے)',
  delivered: 'Delivered · ڈیلیور ہو گیا',
  reason: 'Why not · کیوں نہیں',
  failed: 'Couldn’t deliver · ڈیلیور نہیں ہو سکا',
  today: (delivered: number, failed: number) =>
    `Today: ${delivered} delivered, ${failed} not · آج: ${delivered} ڈیلیور، ${failed} نہیں`,
  held: (amount: string) => `Cash with you: ${amount} · آپ کے پاس رقم: ${amount}`,
  refused: {
    none: 'That delivery is not yours to change now · یہ ڈیلیوری اب آپ کی نہیں',
    code: 'That is not the customer’s code: ask them again · یہ گاہک کا کوڈ نہیں: دوبارہ پوچھیں',
    tries:
      'The code was typed wrong too often: deliver without it, or ask the shop · کوڈ بہت بار غلط لکھا گیا',
    cash: 'Give the cash in rupees, at most what is owed · رقم روپوں میں، واجب الادا سے زیادہ نہیں',
  },
  done: 'Saved · محفوظ ہو گیا',
} as const;

/** The rider's page, plain HTML, with nothing to load from anywhere. */
export function riderPage(
  view: RiderPageView | null,
  secret: string,
  message?: { tone: 'note' | 'done'; text: string },
  /** The order's page a delivery's customer is shown as a QR code, to pay online (ADR-846). */
  door?: { deliveryId: string; url: string },
): string {
  const amount = (minor: bigint) => formatMoney(money(minor, (view?.currency ?? 'PKR') as 'PKR'));
  const body = !view
    ? `<p>${escape(WORDS.nothing)}</p>`
    : [
        `<p class="shop">${escape(view.shop)}</p>`,
        `<h1>${escape(view.rider)}</h1>`,
        message ? `<p class="${message.tone}" role="alert">${escape(message.text)}</p>` : '',
        `<p>${escape(WORDS.today(view.delivered, view.failed))}</p>`,
        `<p><strong>${escape(WORDS.held(amount(view.cashHeld)))}</strong></p>`,
        view.stops.length === 0
          ? `<p>${escape(WORDS.none)}</p>`
          : view.stops.map((stop) => stopSection(stop, secret, amount, door)).join(''),
      ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(WORDS.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:0 auto;padding:1rem;color:#111}h1{font-size:1.25rem;margin:.25rem 0}h2{font-size:1.1rem;margin:0}.shop{color:#555;margin:0}section{border:1px solid #ddd;border-radius:.75rem;padding:1rem;margin:1rem 0}a.button,button{display:inline-block;min-height:3rem;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #bbb;background:#fff;font:inherit;color:#111;text-decoration:none;margin:.25rem .25rem 0 0}button.go{background:#166534;color:#fff;border-color:#166534}label{display:block;margin-top:.5rem}input,select{font:inherit;min-height:3rem;width:100%;box-sizing:border-box;padding:.25rem .5rem}.note{background:#fff4e5;padding:.5rem .75rem;border-radius:.5rem}.done{background:#e8f5e9;padding:.5rem .75rem;border-radius:.5rem}.qr svg{display:block;width:100%;max-width:16rem;height:auto;margin:.5rem auto;background:#fff}</style></head><body>${body}</body></html>`;
}

function stopSection(
  stop: RiderStop,
  secret: string,
  amount: (minor: bigint) => string,
  door?: { deliveryId: string; url: string },
): string {
  const { delivery } = stop;
  const action = (what: string) => `/${RIDER_LINK_PATH}/${escape(secret)}/${delivery.id}/${what}`;
  const phone = stop.phone;
  const links = [
    phone ? `<a class="button" href="tel:${escape(phone)}">${escape(WORDS.call)}</a>` : '',
    phone
      ? `<a class="button" href="https://wa.me/${escape(phone.replace(/^\+/, ''))}">${escape(WORDS.whatsapp)}</a>`
      : '',
    stop.mapUrl ? `<a class="button" href="${escape(stop.mapUrl)}">${escape(WORDS.map)}</a>` : '',
  ].join('');
  const due = stop.due;
  const said =
    due > 0n
      ? WORDS.collect(amount(due))
      : delivery.cashDue > 0n
        ? WORDS.paidOnline
        : WORDS.prepaid;
  // Its customer pays online instead (ADR-846): the order's page as a QR code, once asked for.
  const online =
    door?.deliveryId === delivery.id
      ? `<div class="qr">${toMarkup(qrCode(door.url, stop.order))}</div><p>${escape(WORDS.scan(amount(due)))}</p><p><a class="button" href="/${RIDER_LINK_PATH}/${escape(secret)}">${escape(WORDS.reload)}</a></p>`
      : stop.payable
        ? `<form method="post" action="${action('pay')}"><button type="submit">${escape(WORDS.payOnline)}</button></form>`
        : '';
  return `<section><h2>${escape(stop.order)} · <bdi>${escape(stop.customer)}</bdi></h2>${stop.lines
    .map((line) => `<div dir="auto">${escape(line)}</div>`)
    .join(
      '',
    )}<p><strong>${escape(said)}</strong></p><p>${links}</p>${online}<form method="post" action="${action('delivered')}">${
    delivery.codeSent
      ? `<label>${escape(WORDS.code)}<input name="code" inputmode="numeric" autocomplete="off" maxlength="4"></label>`
      : `<p>${escape(WORDS.noCode)}</p><input type="hidden" name="code" value="">`
  }${
    due > 0n
      ? `<label>${escape(WORDS.cash)}<input name="cash" inputmode="decimal" value="${escape((Number(due) / 100).toString())}"></label>`
      : '<input type="hidden" name="cash" value="0">'
  }<button class="go" type="submit">${escape(WORDS.delivered)}</button></form><form method="post" action="${action('failed')}"><label>${escape(WORDS.reason)}<select name="reason">${Object.entries(
    FAILED_REASONS,
  )
    .map(([key, words]) => `<option value="${key}">${escape(`${words.en} · ${words.ur}`)}</option>`)
    .join(
      '',
    )}</select></label><button type="submit">${escape(WORDS.failed)}</button></form></section>`;
}

/**
 * Sent with every answer: the address carries the link's secret, so the page is never cached,
 * indexed or framed, and browsers send its address to no other site. Its forms post to itself.
 */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** The structural reply the controller needs of Fastify's. */
interface Reply {
  code(status: number): Reply;
  headers(values: Record<string, string>): Reply;
  header(name: string, value: string): Reply;
  send(body?: string): unknown;
}

const field = (body: unknown, name: string): string => {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value.slice(0, 100) : '';
};

/**
 * A rider's link (ADR-825): GET /rider/<secret> shows what they carry; POST
 * /rider/<secret>/<delivery>/delivered or /failed records it, then sends them back to the page,
 * so reloading posts nothing.
 */
@Controller(RIDER_LINK_PATH)
export class RiderPageController {
  constructor(private readonly pages: RiderPageService) {}

  @Get(':secret')
  async show(
    @Param('secret') secret: string,
    @Query('done') done: string | undefined,
    @Res() reply: Reply,
  ): Promise<void> {
    const view = await this.pages.view(secret);
    await reply
      .code(view ? 200 : 404)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        riderPage(
          view,
          secret,
          done !== undefined ? { tone: 'done', text: WORDS.done } : undefined,
        ),
      );
  }

  @Post(':secret/:delivery/delivered')
  async delivered(
    @Param('secret') secret: string,
    @Param('delivery') delivery: string,
    @Body() body: unknown,
    @Res() reply: Reply,
  ): Promise<void> {
    const result = await this.pages.deliver(secret, delivery, {
      code: field(body, 'code'),
      cash: field(body, 'cash'),
    });
    await this.#answer(secret, result, reply);
  }

  @Post(':secret/:delivery/pay')
  async pay(
    @Param('secret') secret: string,
    @Param('delivery') delivery: string,
    @Res() reply: Reply,
  ): Promise<void> {
    const url = await this.pages.doorLink(secret, delivery);
    const view = await this.pages.view(secret);
    await reply
      .code(!view ? 404 : url ? 200 : 422)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        url
          ? riderPage(view, secret, undefined, { deliveryId: delivery, url })
          : riderPage(view, secret, { tone: 'note', text: WORDS.noDoorLink }),
      );
  }

  @Post(':secret/:delivery/failed')
  async failed(
    @Param('secret') secret: string,
    @Param('delivery') delivery: string,
    @Body() body: unknown,
    @Res() reply: Reply,
  ): Promise<void> {
    await this.#answer(
      secret,
      await this.pages.fail(secret, delivery, field(body, 'reason')),
      reply,
    );
  }

  async #answer(
    secret: string,
    result: { ok: true } | { refused: RiderRefusal },
    reply: Reply,
  ): Promise<void> {
    if ('ok' in result) {
      // Back to the rider's page.
      await reply
        .code(303)
        .headers(PRIVATE_PAGE_HEADERS)
        .header('location', `/${RIDER_LINK_PATH}/${secret}?done`)
        .send();
      return;
    }
    const view = await this.pages.view(secret);
    await reply
      .code(view ? 422 : 404)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      .send(riderPage(view, secret, { tone: 'note', text: WORDS.refused[result.refused] }));
  }
}

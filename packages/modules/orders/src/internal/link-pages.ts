import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import {
  html,
  ltr,
  renderPage,
  say,
  text,
  type Html,
  type HtmlValue,
  type RenderedPage,
  type Words,
} from '@hatti/documents';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, maskPkMobile, type PkProvinceCode } from '@hatti/pk';
import type { DraftLinkView } from './draft-order.service.js';
import type { LinkProblem, LinkShop } from './links.js';
import type { OrderLinkView } from './order-link.service.js';
import type { OrderRecord } from './records.js';
import { awaitsCustomer, orderName } from './rules.js';
import { shownOfDraft, shownOfOrder, type ShownOrder } from './shown-order.js';

/** A link's page and its HTTP status. */
export interface LinkPage extends RenderedPage {
  status: number;
}

// Labels, in the words of the shop's documents.
const LABELS = {
  confirmTitle: { en: 'Confirm your order', ur: 'اپنا آرڈر کنفرم کریں' },
  yourOrder: { en: 'Your order', ur: 'آپ کا آرڈر' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  discount: { en: 'Discount', ur: 'رعایت' },
  shipping: { en: 'Delivery charges', ur: 'ڈیلیوری چارجز' },
  total: { en: 'Total', ur: 'کل رقم' },
  advance: { en: 'Paid in advance', ur: 'پیشگی ادائیگی' },
  paid: { en: 'Paid', ur: 'ادا شدہ' },
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  shipTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
  courier: { en: 'Courier', ur: 'کوریئر' },
  track: { en: 'Track', ur: 'ٹریک کریں' },
  confirm: { en: 'Confirm order', ur: 'آرڈر کنفرم کریں' },
  cancelLink: { en: 'Cancel this order', ur: 'یہ آرڈر منسوخ کریں' },
  cancelTitle: { en: 'Cancel your order?', ur: 'آرڈر منسوخ کریں؟' },
  cancelYes: { en: 'Yes, cancel my order', ur: 'جی ہاں، آرڈر منسوخ کریں' },
  keepLink: { en: 'No, keep my order', ur: 'نہیں، آرڈر برقرار رکھیں' },
  confirmedTitle: { en: 'Order confirmed', ur: 'آرڈر کنفرم ہو گیا' },
  placedTitle: { en: 'Order placed', ur: 'آرڈر موصول ہو گیا' },
  onItsWayTitle: { en: 'On its way', ur: 'آرڈر راستے میں ہے' },
  deliveredTitle: { en: 'Delivered', ur: 'آرڈر پہنچ گیا' },
  notDeliveredTitle: { en: 'Not delivered', ur: 'آرڈر ڈیلیور نہیں ہوا' },
  cancelledTitle: { en: 'Order cancelled', ur: 'آرڈر منسوخ ہو گیا' },
  expiredTitle: { en: 'This link has expired', ur: 'اس لنک کی مدت ختم ہو گئی ہے' },
  notFoundTitle: { en: "This link doesn't work", ur: 'یہ لنک کام نہیں کر رہا' },
} satisfies Record<string, Words>;

/**
 * The page a draft's link shows: the order to confirm, or, once it became an order, how the
 * order is doing, or why there is nothing to show. Bilingual, as the customer's language is not
 * known. Their number is masked, since links get forwarded; the address is whole, for them to
 * check.
 */
export function draftLinkPage(view: DraftLinkView): LinkPage {
  switch (view.kind) {
    case 'not_found':
      return notFoundPage();
    case 'expired':
      return expiredPage(view.shop);
    case 'open':
      return confirmPage({
        shop: view.shop,
        shown: shownOfDraft(view.draft),
        digest: view.shown,
        problem: view.problem,
        expiresAt: view.draft.linkExpiresAt,
      });
    case 'completed':
      return statusPage(view.shop, view.order, null);
  }
}

/**
 * The page an order's link shows: while a cash-on-delivery order waits for its customer, the
 * order to confirm or cancel (`askingToCancel` asks whether they are sure); after that, how the
 * order is doing; or why there is nothing to show.
 */
export function orderLinkPage(
  view: OrderLinkView,
  options: { askingToCancel?: boolean } = {},
): LinkPage {
  switch (view.kind) {
    case 'not_found':
      return notFoundPage();
    case 'expired':
      return expiredPage(view.shop);
    case 'order': {
      const { shop, order } = view;
      if (!awaitsCustomer(order)) return statusPage(shop, order, view.problem);
      if (options.askingToCancel && !view.problem) return cancelPage(shop, order, view.shown);
      return confirmPage({
        shop,
        shown: shownOfOrder(order),
        digest: view.shown,
        problem: view.problem,
        expiresAt: order.linkExpiresAt,
        order,
      });
    }
  }
}

function notFoundPage(): LinkPage {
  return page(404, LABELS.notFoundTitle.en, [
    heading(LABELS.notFoundTitle),
    paragraphs(
      {
        en: 'It may have been replaced by a newer one. Ask the shop in your chat for a new link.',
        ur: 'ہو سکتا ہے اس کی جگہ نیا لنک بھیجا گیا ہو۔ اپنی چیٹ میں دکان سے نیا لنک مانگیں۔',
      },
      'center muted',
    ),
  ]);
}

function expiredPage(shop: LinkShop): LinkPage {
  return page(410, `${LABELS.expiredTitle.en} · ${shop.name}`, [
    shopName(shop),
    heading(LABELS.expiredTitle),
    paragraphs(
      {
        en: `Ask ${shop.name} in your chat for a new link.`,
        ur: 'اپنی چیٹ میں دکان سے نیا لنک مانگیں۔',
      },
      'center muted',
    ),
  ]);
}

/**
 * The order to confirm: a draft's, or an order's, which the customer may cancel too. The form
 * carries `digest`, what the page showed.
 */
function confirmPage(options: {
  shop: LinkShop;
  shown: ShownOrder;
  digest: string;
  problem: LinkProblem | null;
  expiresAt: Date | null;
  order?: OrderRecord;
}): LinkPage {
  const { shop, shown, problem, order } = options;
  return page(problem ? 409 : 200, `${LABELS.confirmTitle.en} · ${shop.name}`, [
    shopName(shop),
    heading(LABELS.confirmTitle),
    order && html`<p class="center muted">${ltr(orderName(order.number))}</p>`,
    problem && banner(problemWords(problem, shown)),
    summary(shown),
    address(shown),
    html`<form method="post">
      <input type="hidden" name="action" value="confirm" />
      <input type="hidden" name="shown" value="${options.digest}" />
      <button class="button stack" type="submit">${say('bilingual', LABELS.confirm)}</button>
    </form>`,
    order &&
      html`<div class="text center small">
        <p><a href="?cancel">${say('bilingual', LABELS.cancelLink)}</a></p>
      </div>`,
    paragraphs(
      {
        en: 'Anything wrong? Reply to the shop in your chat before you confirm.',
        ur: 'کچھ غلط ہے؟ کنفرم کرنے سے پہلے اپنی چیٹ میں دکان کو بتائیں۔',
      },
      'small muted',
    ),
    options.expiresAt && until(options.expiresAt, shop.timezone),
  ]);
}

/** Asks whether the customer means to cancel, before anything happens. */
function cancelPage(shop: LinkShop, order: OrderRecord, digest: string): LinkPage {
  const name = orderName(order.number);
  return page(200, `${LABELS.cancelTitle.en} · ${shop.name}`, [
    shopName(shop),
    heading(LABELS.cancelTitle),
    paragraphs(
      {
        en: `Order ${name} will be cancelled, and nothing will be sent to you.`,
        ur: html`آرڈر ${ltr(name)} منسوخ ہو جائے گا اور آپ کو کچھ نہیں بھیجا جائے گا۔`,
      },
      'center',
    ),
    html`<form method="post">
      <input type="hidden" name="action" value="cancel" />
      <input type="hidden" name="shown" value="${digest}" />
      <button class="button danger stack" type="submit">
        ${say('bilingual', LABELS.cancelYes)}
      </button>
    </form>`,
    html`<p class="center"><a href="?">${say('bilingual', LABELS.keepLink)}</a></p>`,
  ]);
}

/** How the order is doing, once it no longer waits for the customer. */
function statusPage(shop: LinkShop, order: OrderRecord, problem: LinkProblem | null): LinkPage {
  const name = orderName(order.number);
  const shown = shownOfOrder(order);
  const pay =
    shown.due > 0n &&
    paragraphs(
      {
        en: `You pay ${amount(shown.due, shown.currency)} when it arrives.`,
        ur: html`آرڈر ملنے پر ${ltr(amount(shown.due, shown.currency))} ادا کریں۔`,
      },
      'center strong',
    );
  const show = (title: Words, sentence: Sentence, mark: boolean, ...rest: HtmlValue[]) =>
    page(problem ? 409 : 200, `${title.en} · ${shop.name}`, [
      shopName(shop),
      problem && banner(problemWords(problem, shown)),
      mark && html`<div class="mark" aria-hidden="true">✓</div>`,
      heading(title),
      paragraphs(sentence, 'center'),
      ...rest,
    ]);

  switch (order.stage) {
    case 'cancelled':
      return show(
        LABELS.cancelledTitle,
        {
          en: `Your order ${name} was cancelled. Ask ${shop.name} in your chat if this is a mistake.`,
          ur: html`آپ کا آرڈر ${ltr(name)} منسوخ ہو چکا ہے۔ اگر یہ غلطی ہے تو اپنی چیٹ میں دکان سے
          پوچھیں۔`,
        },
        false,
      );
    case 'to_pack':
    case 'to_book':
      return show(
        LABELS.confirmedTitle,
        {
          en: `Thank you! Your order ${name} is confirmed, and ${shop.name} will send it soon.`,
          ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔`,
        },
        true,
        pay,
        summary(shown),
      );
    case 'partially_fulfilled':
    case 'in_transit':
      return show(
        LABELS.onItsWayTitle,
        {
          en: `Your order ${name} is on its way.`,
          ur: html`آپ کا آرڈر ${ltr(name)} راستے میں ہے۔`,
        },
        false,
        pay,
        parcels(order),
        summary(shown),
      );
    case 'delivered':
    case 'completed':
      return show(
        LABELS.deliveredTitle,
        {
          en: `Your order ${name} was delivered. Thank you for shopping with ${shop.name}!`,
          ur: html`آپ کا آرڈر ${ltr(name)} پہنچ گیا ہے۔ خریداری کا شکریہ!`,
        },
        true,
      );
    case 'returning':
    case 'returned':
      return show(
        LABELS.notDeliveredTitle,
        {
          en:
            `Your order ${name} was not delivered and is going back to ${shop.name}. Ask them ` +
            'in your chat if this is a mistake.',
          ur: html`آپ کا آرڈر ${ltr(name)} ڈیلیور نہیں ہوا اور دکان کو واپس بھیجا جا رہا ہے۔ اگر یہ
          غلطی ہے تو اپنی چیٹ میں دکان سے پوچھیں۔`,
        },
        false,
      );
    case 'needs_confirmation':
    case 'needs_review':
      // Placed by staff and not confirmed yet, or held for review: the customer is not told
      // which.
      return show(
        LABELS.placedTitle,
        {
          en: `Thank you! ${shop.name} has your order ${name} and will be in touch before sending it.`,
          ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان آپ سے رابطہ
          کرے گی۔`,
        },
        true,
        pay,
        summary(shown),
      );
  }
}

function page(status: number, title: string, body: HtmlValue[]): LinkPage {
  return { status, ...renderPage({ title, body: html`${body}` }) };
}

function shopName(shop: LinkShop): Html {
  return html`<p class="shop">${text(shop.name)}</p>`;
}

function heading(words: Words): Html {
  return html`<h1 class="title stack">${say('bilingual', words)}</h1>`;
}

/**
 * A sentence in English and in Urdu, which may hold markup: numbers, amounts and dates in an
 * Urdu sentence go in ltr(), or the right-to-left text around them reorders their parts.
 */
interface Sentence {
  en: HtmlValue;
  ur: HtmlValue;
}

/** A sentence in English, then in Urdu, right to left. */
function paragraphs(sentence: Sentence, className: string): Html {
  return html`<div class="text ${className}">
    <p lang="en">${sentence.en}</p>
    <p lang="ur" dir="rtl">${sentence.ur}</p>
  </div>`;
}

function banner(sentence: Sentence): Html {
  return html`<div class="banner" role="alert">${paragraphs(sentence, '')}</div>`;
}

function problemWords(problem: LinkProblem, shown: ShownOrder): Sentence {
  switch (problem.kind) {
    case 'changed':
      return {
        en: 'This order changed after you opened it. Check it again, then confirm.',
        ur: 'آپ کے کھولنے کے بعد اس آرڈر میں تبدیلی ہوئی ہے۔ اسے دوبارہ دیکھ کر کنفرم کریں۔',
      };
    case 'unavailable': {
      const items = problem.lines
        .map((index) => shown.lines[index])
        .filter((line) => line !== undefined)
        .map(itemName)
        .join(', ');
      return {
        en: `Sorry, ${items} can't be ordered now. Ask the shop in your chat what they can offer.`,
        ur: html`معذرت، ${text(items)} اب دستیاب نہیں۔ اپنی چیٹ میں دکان سے پوچھیں۔`,
      };
    }
    case 'refused':
      return {
        en: "Sorry, the shop can't take this order right now. Ask them in your chat.",
        ur: 'معذرت، دکان ابھی یہ آرڈر نہیں لے سکتی۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
    case 'too_late':
      return {
        en: "This order can't be cancelled here any more. Ask the shop in your chat.",
        ur: 'یہ آرڈر اب یہاں منسوخ نہیں ہو سکتا۔ اپنی چیٹ میں دکان سے پوچھیں۔',
      };
  }
}

/** "Peshawari Chappal (8)"; a product without options by its title alone. */
function itemName(line: { title: string; variantTitle: string }): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE
    ? line.title
    : `${line.title} (${line.variantTitle})`;
}

function amount(value: bigint, currency: CurrencyCode): string {
  return formatMoney(money(value, currency));
}

/** The items and what they come to, down to what is paid at the door. */
function summary(shown: ShownOrder): Html {
  const row = (label: Words, value: string, className = '') =>
    html`<tr class="${className}">
      <td>${say('bilingual', label)}</td>
      <td class="num">${ltr(value)}</td>
    </tr>`;
  const rs = (value: bigint) => amount(value, shown.currency);
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
    <table>
      ${shown.lines.map(
        (line) =>
          html`<tr>
            <td>${ltr(`${line.quantity} ×`)} ${text(itemName(line))}</td>
            <td class="num">${ltr(rs(line.total))}</td>
          </tr>`,
      )}
    </table>
    <table>
      ${row(LABELS.subtotal, rs(shown.subtotal))}
      ${shown.discount > 0n && row(LABELS.discount, `-${rs(shown.discount)}`)}
      ${row(LABELS.shipping, rs(shown.shipping))} ${row(LABELS.total, rs(shown.total), 'total')}
      ${
        shown.cashOnDelivery
          ? [
              shown.paid > 0n && row(LABELS.advance, `-${rs(shown.paid)}`),
              row(LABELS.payOnDelivery, rs(shown.due), 'due'),
            ]
          : row(LABELS.paid, rs(shown.paid))
      }
    </table>
  </section>`;
}

/** Where it goes, with the number masked. */
function address(shown: ShownOrder): Html {
  const to = shown.address;
  if (!to) return html``;
  const province = to.provinceCode ? PK_PROVINCES[to.provinceCode as PkProvinceCode].name : null;
  const lines = [
    text(to.name),
    to.phone && ltr(maskPkMobile(to.phone)),
    text(to.address1),
    to.address2 && text(to.address2),
    text([[to.city, to.zip].filter(Boolean).join(' '), province].filter(Boolean).join(', ')),
  ].filter((line): line is Html => Boolean(line));
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.shipTo)}</h2>
    <p>${lines.map((line, index) => html`${index > 0 && html`<br />`}${line}`)}</p>
  </section>`;
}

/** Each parcel's courier and tracking number, with a link to follow it where there is one. */
function parcels(order: OrderRecord): Html {
  const tracked = order.fulfillments.filter(
    (parcel) => parcel.trackingCompany !== null || parcel.trackingNumber !== null,
  );
  if (tracked.length === 0) return html``;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.courier)}</h2>
    ${tracked.map(
      (parcel) =>
        html`<p>
          ${ltr([parcel.trackingCompany, parcel.trackingNumber].filter(Boolean).join(' '))}
          ${
            parcel.trackingUrl?.startsWith('https://') &&
            html`· <a href="${parcel.trackingUrl}">${say('bilingual', LABELS.track)}</a>`
          }
        </p>`,
    )}
  </section>`;
}

/** "This link works until 2 Oct 2026, 5:30 pm", in the shop's time zone. */
function until(expiresAt: Date, timeZone: string): Html {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(expiresAt)
      .map((part) => [part.type, part.value]),
  );
  const when =
    `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ` +
    (parts.dayPeriod ?? '').toLowerCase();
  return paragraphs(
    { en: `This link works until ${when}.`, ur: html`یہ لنک ${ltr(when)} تک کام کرے گا۔` },
    'small muted',
  );
}

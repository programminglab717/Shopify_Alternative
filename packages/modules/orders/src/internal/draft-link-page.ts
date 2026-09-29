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
import type { DraftLinkView, LinkProblem, LinkShop } from './draft-order.service.js';
import type { DraftOrderLineRecord, DraftOrderRecord, OrderRecord } from './records.js';
import { orderName } from './rules.js';

/** A link's page and its HTTP status. */
export interface DraftLinkPage extends RenderedPage {
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
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  shipTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
  confirm: { en: 'Confirm order', ur: 'آرڈر کنفرم کریں' },
  confirmedTitle: { en: 'Order confirmed', ur: 'آرڈر کنفرم ہو گیا' },
  placedTitle: { en: 'Order placed', ur: 'آرڈر موصول ہو گیا' },
  cancelledTitle: { en: 'Order cancelled', ur: 'آرڈر منسوخ ہو گیا' },
  expiredTitle: { en: 'This link has expired', ur: 'اس لنک کی مدت ختم ہو گئی ہے' },
  notFoundTitle: { en: "This link doesn't work", ur: 'یہ لنک کام نہیں کر رہا' },
} satisfies Record<string, Words>;

/**
 * The page a draft's link shows: the order to confirm, what became of it, or why there is
 * nothing to show. Bilingual, as the customer's language is not known. Their number is masked,
 * since links get forwarded; the address is whole, for them to check.
 */
export function draftLinkPage(view: DraftLinkView): DraftLinkPage {
  switch (view.kind) {
    case 'not_found':
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
    case 'expired':
      return page(410, `${LABELS.expiredTitle.en} · ${view.shop.name}`, [
        shopName(view.shop),
        heading(LABELS.expiredTitle),
        paragraphs(
          {
            en: `Ask ${view.shop.name} in your chat for a new link.`,
            ur: 'اپنی چیٹ میں دکان سے نیا لنک مانگیں۔',
          },
          'center muted',
        ),
      ]);
    case 'open':
      return page(view.problem ? 409 : 200, `${LABELS.confirmTitle.en} · ${view.shop.name}`, [
        shopName(view.shop),
        heading(LABELS.confirmTitle),
        view.problem && banner(problemWords(view.problem, view.draft)),
        summary(view.draft),
        address(view.draft),
        html`<form method="post">
          <input type="hidden" name="version" value="${view.draft.version}" />
          <button class="button stack" type="submit">${say('bilingual', LABELS.confirm)}</button>
        </form>`,
        paragraphs(
          {
            en: 'Anything wrong? Reply to the shop in your chat before you confirm.',
            ur: 'کچھ غلط ہے؟ کنفرم کرنے سے پہلے اپنی چیٹ میں دکان کو بتائیں۔',
          },
          'small muted',
        ),
        view.draft.linkExpiresAt && until(view.draft.linkExpiresAt, view.shop.timezone),
      ]);
    case 'completed':
      return completedPage(view.shop, view.draft, view.order);
  }
}

function completedPage(shop: LinkShop, draft: DraftOrderRecord, order: OrderRecord): DraftLinkPage {
  const name = orderName(order.number);
  const due = order.codAmount > 0n ? amount(order.codAmount, order.currency) : null;
  const pay = due && {
    en: `You pay ${due} when it arrives.`,
    ur: html`آرڈر ملنے پر ${ltr(due)} ادا کریں۔`,
  };
  if (order.status === 'cancelled') {
    return page(200, `${LABELS.cancelledTitle.en} · ${shop.name}`, [
      shopName(shop),
      heading(LABELS.cancelledTitle),
      paragraphs(
        {
          en: `Your order ${name} was cancelled. Ask ${shop.name} in your chat if this is a mistake.`,
          ur: html`آپ کا آرڈر ${ltr(name)} منسوخ ہو چکا ہے۔ اگر یہ غلطی ہے تو اپنی چیٹ میں دکان سے
          پوچھیں۔`,
        },
        'center',
      ),
    ]);
  }
  // Confirmed by the customer, or placed by staff and not confirmed yet, or held for review:
  // the customer is not told which of the last two.
  const confirmed =
    order.confirmationStatus === 'confirmed' || order.confirmationStatus === 'not_required';
  const title = confirmed ? LABELS.confirmedTitle : LABELS.placedTitle;
  return page(200, `${title.en} · ${shop.name}`, [
    shopName(shop),
    html`<div class="mark" aria-hidden="true">✓</div>`,
    heading(title),
    paragraphs(
      confirmed
        ? {
            en: `Thank you! Your order ${name} is confirmed, and ${shop.name} will send it soon.`,
            ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} کنفرم ہو گیا ہے اور جلد روانہ کر دیا جائے گا۔`,
          }
        : {
            en: `Thank you! ${shop.name} has your order ${name} and will be in touch before sending it.`,
            ur: html`شکریہ! آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان آپ سے رابطہ
            کرے گی۔`,
          },
      'center',
    ),
    pay && paragraphs(pay, 'center strong'),
    summary(draft),
  ]);
}

function page(status: number, title: string, body: HtmlValue[]): DraftLinkPage {
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

function problemWords(problem: LinkProblem, draft: DraftOrderRecord): Sentence {
  switch (problem.kind) {
    case 'changed':
      return {
        en: 'This order changed after you opened it. Check it again, then confirm.',
        ur: 'آپ کے کھولنے کے بعد اس آرڈر میں تبدیلی ہوئی ہے۔ اسے دوبارہ دیکھ کر کنفرم کریں۔',
      };
    case 'unavailable': {
      const items = problem.lines
        .map((index) => draft.lines[index])
        .filter((line): line is DraftOrderLineRecord => line !== undefined)
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
  }
}

/** "Peshawari Chappal (8)"; a product without options by its title alone. */
function itemName(line: DraftOrderLineRecord): string {
  return line.variantTitle === DEFAULT_VARIANT_TITLE
    ? line.title
    : `${line.title} (${line.variantTitle})`;
}

function amount(value: bigint, currency: CurrencyCode): string {
  return formatMoney(money(value, currency));
}

/** The items and what they come to, down to what is paid at the door. */
function summary(draft: DraftOrderRecord): Html {
  const row = (label: Words, value: string, className = '') =>
    html`<tr class="${className}">
      <td>${say('bilingual', label)}</td>
      <td class="num">${ltr(value)}</td>
    </tr>`;
  const rs = (value: bigint) => amount(value, draft.currency);
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
    <table>
      ${draft.lines.map(
        (line) =>
          html`<tr>
            <td>${ltr(`${line.quantity} ×`)} ${text(itemName(line))}</td>
            <td class="num">${ltr(rs(line.total))}</td>
          </tr>`,
      )}
    </table>
    <table>
      ${row(LABELS.subtotal, rs(draft.subtotal))}
      ${draft.discount > 0n && row(LABELS.discount, `-${rs(draft.discount)}`)}
      ${row(LABELS.shipping, rs(draft.shipping))} ${row(LABELS.total, rs(draft.total), 'total')}
      ${draft.advancePaid > 0n && row(LABELS.advance, `-${rs(draft.advancePaid)}`)}
      ${
        draft.paymentMethod === 'cash_on_delivery' &&
        row(LABELS.payOnDelivery, rs(draft.codAmount), 'due')
      }
    </table>
  </section>`;
}

/** Where it goes, with the number masked. */
function address(draft: DraftOrderRecord): Html {
  const to = draft.shippingAddress;
  if (!to) return html``;
  const province = to.provinceCode ? PK_PROVINCES[to.provinceCode as PkProvinceCode].name : null;
  const lines = [
    text(to.name),
    ltr(maskPkMobile(to.phone)),
    text(to.address1),
    to.address2 && text(to.address2),
    text([[to.city, to.zip].filter(Boolean).join(' '), province].filter(Boolean).join(', ')),
  ].filter((line): line is Html => Boolean(line));
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.shipTo)}</h2>
    <p>${lines.map((line, index) => html`${index > 0 && html`<br />`}${line}`)}</p>
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

import type { FieldError } from '@hatti/api';
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
import { formatMoney, money } from '@hatti/money';
import { POLICY_TITLES, policyHandle, type PolicyType } from '@hatti/online-store/public';
import { orderName, type OrderRecord } from '@hatti/orders/public';
import { PK_CITIES, PK_PROVINCES, maskPkMobile, type PkProvinceCode } from '@hatti/pk';
import type { CartJson } from '@hatti/storefront-api';
import {
  itemName,
  shownProperties,
  type CheckoutForm,
  type CheckoutProblem,
  type CheckoutShop,
  type CheckoutView,
} from './checkout.service.js';
import { deliveryCharge, type DeliverySettingsRecord } from './delivery.js';

/** A checkout's page and its HTTP status. */
export interface CheckoutPage extends RenderedPage {
  status: number;
}

const LABELS = {
  title: { en: 'Checkout', ur: 'چیک آؤٹ' },
  yourOrder: { en: 'Your order', ur: 'آپ کا آرڈر' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  delivery: { en: 'Delivery', ur: 'ڈیلیوری' },
  free: { en: 'Free', ur: 'مفت' },
  byCity: { en: 'By city', ur: 'شہر کے مطابق' },
  total: { en: 'Total', ur: 'کل رقم' },
  payOnDelivery: { en: 'Pay on delivery', ur: 'ڈیلیوری پر ادائیگی' },
  deliverTo: { en: 'Deliver to', ur: 'ترسیل کا پتہ' },
  payment: { en: 'Payment', ur: 'ادائیگی' },
  note: { en: 'Your note', ur: 'آپ کا نوٹ' },
  name: { en: 'Name', ur: 'نام' },
  mobile: { en: 'Mobile number', ur: 'موبائل نمبر' },
  city: { en: 'City', ur: 'شہر' },
  address1: { en: 'House and street', ur: 'مکان اور گلی' },
  address2: { en: 'Area or landmark (optional)', ur: 'علاقہ یا قریبی نشانی (اختیاری)' },
  province: { en: 'Province', ur: 'صوبہ' },
  fromCity: { en: 'From the city', ur: 'شہر کے مطابق' },
  placeOrder: { en: 'Place order', ur: 'آرڈر دیں' },
  backToCart: { en: 'Back to cart', ur: 'واپس کارٹ پر' },
  continueShopping: { en: 'Continue shopping', ur: 'خریداری جاری رکھیں' },
  placedTitle: { en: 'Thank you!', ur: 'شکریہ!' },
  emptyTitle: { en: 'Your cart is empty', ur: 'آپ کا کارٹ خالی ہے' },
  expiredTitle: { en: 'This checkout has expired', ur: 'اس چیک آؤٹ کی مدت ختم ہو گئی ہے' },
  notFoundTitle: { en: "This checkout doesn't exist", ur: 'یہ چیک آؤٹ موجود نہیں' },
} satisfies Record<string, Words>;

/**
 * A sentence in English and in Urdu, which may hold markup: numbers and amounts in an Urdu
 * sentence go in ltr(), or the right-to-left text around them reorders their parts.
 */
interface Sentence {
  en: HtmlValue;
  ur: HtmlValue;
}

/**
 * The page a checkout shows (ADR-044): the cart to order, with the form for who receives it and
 * where; once placed, the order; or why there is nothing to show. In English and Urdu, as
 * customers' links' pages are, and without scripts: it works on any phone.
 */
export function checkoutPage(view: CheckoutView): CheckoutPage {
  switch (view.kind) {
    case 'not_found':
      return page(404, LABELS.notFoundTitle.en, [
        heading(LABELS.notFoundTitle),
        paragraphs(
          {
            en: 'Go back to the shop and check out from your cart again.',
            ur: 'دکان پر واپس جا کر اپنے کارٹ سے دوبارہ چیک آؤٹ کریں۔',
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
            en: 'Check out from your cart again: it has what you chose.',
            ur: 'اپنے کارٹ سے دوبارہ چیک آؤٹ کریں: آپ کی چنی ہوئی چیزیں اس میں موجود ہیں۔',
          },
          'center muted',
        ),
        link(`${view.shop.storefront}/cart`, LABELS.backToCart),
      ]);
    case 'empty':
      return page(200, `${LABELS.emptyTitle.en} · ${view.shop.name}`, [
        shopName(view.shop),
        heading(LABELS.emptyTitle),
        link(view.shop.storefront, LABELS.continueShopping),
      ]);
    case 'open':
      return openPage(view);
    case 'placed':
      return placedPage(view.shop, view.order);
  }
}

/** The cart to order, what it comes to, and who receives it where; with what stopped it. */
function openPage(view: Extract<CheckoutView, { kind: 'open' }>): CheckoutPage {
  const { shop, cart, delivery, form, problem } = view;
  const errors = problem?.kind === 'address' ? problem.errors : [];
  const status = problem?.kind === 'address' ? 422 : problem ? 409 : 200;
  const agreement = agreementWords(shop);
  return page(status, `${LABELS.title.en} · ${shop.name}`, [
    shopName(shop),
    heading(LABELS.title),
    problem && banner(problemWords(problem)),
    cartSummary(cart, delivery, form.city),
    html`<form method="post">
      <input type="hidden" name="shown" value="${view.shown}" />
      ${field('name', LABELS.name, form, errors, { autocomplete: 'name', required: true })}
      ${field('phone', LABELS.mobile, form, errors, {
        autocomplete: 'tel',
        required: true,
        kind: 'tel',
        hint: {
          en: 'The shop and the courier call this number.',
          ur: 'دکان اور کوریئر اس نمبر پر کال کریں گے۔',
        },
      })}
      ${field('city', LABELS.city, form, errors, {
        autocomplete: 'address-level2',
        required: true,
        list: 'cities',
      })}
      <datalist id="cities">
        ${PK_CITIES.map((city) => html`<option value="${city.name}"></option>`)}
      </datalist>
      ${field('address1', LABELS.address1, form, errors, {
        autocomplete: 'address-line1',
        required: true,
      })}
      ${field('address2', LABELS.address2, form, errors, { autocomplete: 'address-line2' })}
      ${provinceField(form.province, errors)}
      <section class="section">
        <h2 class="label">${say('bilingual', LABELS.payment)}</h2>
        ${paragraphs(
          {
            en: 'Cash on delivery: you pay when your order arrives.',
            ur: 'ڈیلیوری پر نقد ادائیگی: آرڈر ملنے پر رقم ادا کریں۔',
          },
          '',
        )}
      </section>
      ${agreement && paragraphs(agreement, 'small muted')}
      <button class="button stack" type="submit">${say('bilingual', LABELS.placeOrder)}</button>
    </form>`,
    link(`${shop.storefront}/cart`, LABELS.backToCart),
    policyLinks(shop),
  ]);
}

/** The order placed: what happens next, what it comes to, and where it goes. */
function placedPage(shop: CheckoutShop, order: OrderRecord): CheckoutPage {
  const name = orderName(order.number);
  const to = order.shippingAddress;
  const phone = to.phone && maskPkMobile(to.phone);
  const rs = (value: bigint) => amount(value);
  return page(200, `${LABELS.placedTitle.en} · ${shop.name}`, [
    shopName(shop),
    html`<div class="mark" aria-hidden="true">✓</div>`,
    heading(LABELS.placedTitle),
    paragraphs(
      {
        en: `Your order ${name} is placed. ${shop.name} will call or message you${
          phone ? ` on ${phone}` : ''
        } to confirm it before sending it.`,
        ur: html`آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ بھیجنے سے پہلے دکان
        ${phone && html`${ltr(phone)} پر`} رابطہ کر کے اسے کنفرم کرے گی۔`,
      },
      'center',
    ),
    order.codAmount > 0n &&
      paragraphs(
        {
          en: `You pay ${rs(order.codAmount)} when it arrives.`,
          ur: html`آرڈر ملنے پر ${ltr(rs(order.codAmount))} ادا کریں۔`,
        },
        'center strong',
      ),
    html`<section class="section">
      <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
      <table>
        ${order.lines.map((line) =>
          itemRow(line.quantity, itemName(line.title, line.variantTitle), rs(line.total)),
        )}
      </table>
      <table>
        ${row(LABELS.subtotal, rs(order.subtotal))}
        ${row(LABELS.delivery, order.shipping === 0n ? LABELS.free : rs(order.shipping))}
        ${row(LABELS.total, rs(order.total), 'total')}
      </table>
    </section>`,
    to.name &&
      html`<section class="section">
        <h2 class="label">${say('bilingual', LABELS.deliverTo)}</h2>
        <p>
          ${text(to.name)}<br />${phone && html`${ltr(phone)}<br />`}${text(to.address1)}<br />
          ${to.address2 && html`${text(to.address2)}<br />`}${text(addressTail(to))}
        </p>
      </section>`,
    link(shop.storefront, LABELS.continueShopping),
    policyLinks(shop),
  ]);
}

/**
 * The cart's items and what they come to. Delivery is exact once the shopper typed a city, or
 * when every city costs the same; until then, the shop's charges.
 */
function cartSummary(cart: CartJson, delivery: DeliverySettingsRecord, city: string): Html {
  const subtotal = BigInt(cart.subtotal);
  const typed = city.trim();
  const free = delivery.freeAbove !== null && subtotal >= delivery.freeAbove;
  const charge =
    free || delivery.zones.length === 0 || typed !== ''
      ? deliveryCharge(delivery, typed || null, subtotal)
      : null;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', LABELS.yourOrder)}</h2>
    <table>
      ${cart.items.map((item) =>
        itemRow(
          item.quantity,
          itemName(item.title, item.variantTitle),
          amount(BigInt(item.linePrice)),
          shownProperties(item.properties),
        ),
      )}
    </table>
    <table>
      ${row(LABELS.subtotal, amount(subtotal))}
      ${row(LABELS.delivery, charge === null ? LABELS.byCity : charge === 0n ? LABELS.free : amount(charge))}
      ${charge !== null && row(LABELS.payOnDelivery, amount(subtotal + charge), 'due')}
    </table>
    ${charge === null && paragraphs(chargesWords(delivery), 'small muted')}
    ${
      cart.note !== '' &&
      html`<p class="small muted">
        ${say('bilingual', LABELS.note)}: <span dir="auto">${text(cart.note)}</span>
      </p>`
    }
  </section>`;
}

/** What delivery costs where, for a shopper who has not typed their city yet. */
function chargesWords(delivery: DeliverySettingsRecord): Sentence {
  const zones = delivery.zones.map((zone) => {
    const cities = zone.cities.slice(0, 5).join(', ') + (zone.cities.length > 5 ? '…' : '');
    return { cities, charge: amount(zone.charge) };
  });
  const everywhere = amount(delivery.charge);
  const freeFrom = delivery.freeAbove === null ? null : amount(delivery.freeAbove);
  const zoneWords = zones.map((zone) => html`؛ ${ltr(zone.cities)} میں ${ltr(zone.charge)}`);
  const freeWords = freeFrom && html` ${ltr(freeFrom)} یا زیادہ کے آرڈر پر ڈیلیوری مفت۔`;
  return {
    en:
      `Delivery is ${everywhere}` +
      zones.map((zone) => `; ${zone.charge} in ${zone.cities}`).join('') +
      '.' +
      (freeFrom ? ` Free on orders of ${freeFrom} or more.` : ''),
    // One line: a line break would put a space before each "؛" and "۔".
    ur: html`ڈیلیوری ${ltr(everywhere)}${zoneWords}۔${freeWords}`,
  };
}

function problemWords(problem: CheckoutProblem): Sentence {
  switch (problem.kind) {
    case 'changed':
      return {
        en:
          "Your cart, the delivery charges or the shop's policies changed while you were here. " +
          'Check your order again.',
        ur: 'آپ کے یہاں ہوتے ہوئے کارٹ، ڈیلیوری چارجز یا دکان کی پالیسیاں بدل گئیں۔ اپنا آرڈر دوبارہ دیکھیں۔',
      };
    case 'address':
      return {
        en: 'Some of your details are missing or not right. See below.',
        ur: 'آپ کی معلومات میں کچھ کمی یا غلطی ہے۔ نیچے دیکھیں۔',
      };
    case 'unavailable':
      return {
        en: 'Some of your cart is no longer available. Go back to your cart to change it.',
        ur: 'آپ کے کارٹ کی کچھ چیزیں اب دستیاب نہیں۔ کارٹ پر واپس جا کر تبدیلی کریں۔',
      };
    case 'refused':
      return {
        en: "Sorry, the shop can't take orders right now. Please try again later.",
        ur: 'معذرت، دکان ابھی آرڈر نہیں لے سکتی۔ براہ کرم بعد میں دوبارہ کوشش کریں۔',
      };
  }
}

/**
 * A labelled box of the form, with a hint and what is wrong underneath. Autocomplete names the
 * delivery address, for phones that fill it in; typed text runs in its script's direction, and
 * numbers left to right.
 */
function field(
  name: Exclude<keyof CheckoutForm, 'province'>,
  label: Words,
  form: CheckoutForm,
  errors: readonly FieldError[],
  options: {
    autocomplete: string;
    required?: boolean;
    kind?: 'tel';
    list?: string;
    hint?: Sentence;
  },
): Html {
  const error = errors.find((each) => each.field[0] === name);
  const described = [options.hint && `${name}-hint`, error && `${name}-error`].filter(Boolean);
  return html`<div class="field">
    <label class="label" for="${name}">${say('bilingual', label)}</label>
    <input
      id="${name}"
      name="${name}"
      ${options.kind === 'tel' ? html`type="tel" dir="ltr"` : html`type="text" dir="auto"`}
      value="${form[name]}"
      autocomplete="shipping ${options.autocomplete}"
      ${options.list && html`list="${options.list}"`}
      ${options.required && html`aria-required="true"`}
      ${error && html`aria-invalid="true"`}
      ${described.length > 0 && html`aria-describedby="${described.join(' ')}"`}
    />
    ${options.hint && html`<div id="${name}-hint">${paragraphs(options.hint, 'small muted')}</div>`}
    ${error && html`<div id="${name}-error">${paragraphs(errorWords(error), 'error')}</div>`}
  </div>`;
}

/** The province to pick, or none, to take it from the city. */
function provinceField(value: string, errors: readonly FieldError[]): Html {
  const error = errors.find((each) => each.field[0] === 'province');
  const option = (code: string, words: Words) =>
    html`<option value="${code}" ${code === value && html`selected`}>
      ${words.en} · ${words.ur}
    </option>`;
  return html`<div class="field">
    <label class="label" for="province">${say('bilingual', LABELS.province)}</label>
    <select
      id="province"
      name="province"
      autocomplete="shipping address-level1"
      ${error && html`aria-invalid="true" aria-describedby="province-error"`}
    >
      ${option('', LABELS.fromCity)}
      ${Object.entries(PK_PROVINCES).map(([code, province]) =>
        option(code, { en: province.name, ur: province.nameUr }),
      )}
    </select>
    ${error && html`<div id="province-error">${paragraphs(errorWords(error), 'error')}</div>`}
  </div>`;
}

function errorWords(error: FieldError): Sentence {
  const field = error.field[0];
  if (error.code === 'BLANK') {
    switch (field) {
      case 'name':
        return {
          en: 'Enter the name of who receives the parcel.',
          ur: 'پارسل وصول کرنے والے کا نام لکھیں۔',
        };
      case 'phone':
        return { en: 'Enter your mobile number.', ur: 'اپنا موبائل نمبر لکھیں۔' };
      case 'address1':
        return { en: 'Enter the house number and street.', ur: 'مکان نمبر اور گلی لکھیں۔' };
      case 'city':
        return { en: 'Enter the city.', ur: 'شہر کا نام لکھیں۔' };
    }
  }
  if (error.code === 'TOO_LONG') {
    return { en: 'This is too long. Shorten it.', ur: 'یہ بہت لمبا ہے، اسے مختصر کریں۔' };
  }
  switch (field) {
    case 'province':
      return { en: 'Choose a province from the list.', ur: 'فہرست میں سے صوبہ منتخب کریں۔' };
    case 'phone':
      return {
        en: 'Enter a Pakistani mobile number, like 0300 1234567.',
        ur: html`پاکستانی موبائل نمبر لکھیں، جیسے ${ltr('0300 1234567')}۔`,
      };
    default:
      return { en: 'Check this.', ur: 'اسے دوبارہ دیکھیں۔' };
  }
}

function page(status: number, title: string, body: HtmlValue[]): CheckoutPage {
  return { status, ...renderPage({ title, body: html`${body}` }) };
}

function shopName(shop: CheckoutShop): Html {
  return html`<p class="shop">${text(shop.name)}</p>`;
}

/**
 * The shop's policies, linked at the foot of the page as Shopify's checkout links them (ADR-056).
 * Each opens beside the checkout, which keeps what the shopper typed.
 */
function policyLinks(shop: CheckoutShop): Html | false {
  const item = ({ type }: { type: PolicyType }) =>
    html`<p>${policyLink(shop, type, say('bilingual', POLICY_TITLES[type]))}</p>`;
  return (
    shop.policies.length > 0 &&
    html`<nav class="section center small" aria-label="Policies">${shop.policies.map(item)}</nav>`
  );
}

/**
 * What placing the order agrees to (ADR-057): the shop's policies, each linked, but for its
 * contact information, which promises nothing. Nothing when it has none.
 */
function agreementWords(shop: CheckoutShop): Sentence | null {
  const terms = shop.policies.filter((policy) => policy.type !== 'contact_information');
  if (terms.length === 0) return null;
  const en = terms.map(({ type }) => policyLink(shop, type, POLICY_TITLES[type].en.toLowerCase()));
  const ur = terms.map(({ type }) => policyLink(shop, type, POLICY_TITLES[type].ur));
  return {
    en: html`By placing your order, you agree to the shop's ${listOf(en, ', ', ' and ')}.`,
    ur: html`آرڈر دے کر آپ دکان کی ان پالیسیوں سے اتفاق کرتے ہیں: ${listOf(ur, '، ', ' اور ')}۔`,
  };
}

/** A policy's page, opening beside the checkout, which keeps what the shopper typed. */
function policyLink(shop: CheckoutShop, type: PolicyType, title: HtmlValue): Html {
  const href = `${shop.storefront}/policies/${policyHandle(type)}`;
  return html`<a href="${href}" target="_blank" rel="noopener">${title}</a>`;
}

/** "a", "a and b", "a, b and c", with the language's comma and "and". */
function listOf(items: readonly Html[], comma: string, and: string): HtmlValue[] {
  return items.map((item, index) => [
    index === 0 ? '' : index === items.length - 1 ? and : comma,
    item,
  ]);
}

function heading(words: Words): Html {
  return html`<h1 class="title stack">${say('bilingual', words)}</h1>`;
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

function link(href: string, words: Words): Html {
  return html`<p class="center"><a href="${href}">${say('bilingual', words)}</a></p>`;
}

function row(label: Words, value: string | Words, className = ''): Html {
  return html`<tr class="${className}">
    <td>${say('bilingual', label)}</td>
    <td class="num">${typeof value === 'string' ? ltr(value) : say('bilingual', value)}</td>
  </tr>`;
}

/** A line: how many of what, what they come to, and what the shopper added, such as an engraving. */
function itemRow(
  quantity: number,
  name: string,
  total: string,
  properties: readonly [string, string][] = [],
): Html {
  return html`<tr>
    <td>
      ${ltr(`${quantity} ×`)} <span dir="auto">${text(name)}</span>
      ${properties.map(
        ([key, value]) => html`<br /><span class="small muted">${text(`${key}: ${value}`)}</span>`,
      )}
    </td>
    <td class="num">${ltr(total)}</td>
  </tr>`;
}

/** "Lahore, Punjab", as the order keeps its city and province. */
function addressTail(to: OrderRecord['shippingAddress']): string {
  const province = to.provinceCode ? PK_PROVINCES[to.provinceCode as PkProvinceCode].name : null;
  return [to.city, province].filter(Boolean).join(', ');
}

function amount(value: bigint): string {
  return formatMoney(money(value, 'PKR'));
}

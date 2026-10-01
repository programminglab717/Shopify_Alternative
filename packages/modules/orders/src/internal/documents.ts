import type { ShopProfile } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import { html, ltr, say, text, type Html, type Language, type Words } from '@hatti/documents';
import type { LocationRecord } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, parsePkMobile, type PkProvinceCode } from '@hatti/pk';
import { taxIncludedWords } from '@hatti/tax/public';
import { taxByRate } from './order-tax.js';
import type { OrderLineRecord, OrderRecord } from './records.js';
import { orderName } from './rules.js';
import type { StoredAddressValue } from './schema.js';

/** Documents printed for orders: a packing slip to go in the parcel, or an invoice. */
export const DOCUMENT_KINDS = ['packing_slip', 'invoice'] as const;
export type DocumentKindValue = (typeof DOCUMENT_KINDS)[number];

/** What a document needs besides the order. */
export interface DocumentContext {
  language: Language;
  shop: ShopProfile;
  /** Where the order ships from. */
  from: LocationRecord | null;
  /** The customer's number as the caller may see it, whole or masked; null once erased. */
  phone: string | null;
}

// Wording for documents that go to customers, in English and Urdu.
const WORDS = {
  packingSlip: { en: 'Packing slip', ur: 'پیکنگ سلپ' },
  invoice: { en: 'Invoice', ur: 'انوائس' },
  shipTo: { en: 'Ship to', ur: 'ترسیل کا پتہ' },
  billTo: { en: 'Bill to', ur: 'خریدار' },
  payment: { en: 'Payment', ur: 'ادائیگی' },
  cashOnDelivery: { en: 'Cash on delivery', ur: 'کیش آن ڈیلیوری' },
  prepaid: { en: 'Paid in advance', ur: 'پیشگی ادائیگی' },
  bankTransfer: { en: 'Bank transfer', ur: 'بینک ٹرانسفر' },
  cashToCollect: { en: 'Cash to collect', ur: 'وصول کی جانے والی رقم' },
  nothingToCollect: { en: 'Nothing to collect', ur: 'کوئی رقم وصول نہیں کرنی' },
  item: { en: 'Item', ur: 'آئٹم' },
  quantity: { en: 'Qty', ur: 'تعداد' },
  price: { en: 'Price', ur: 'قیمت' },
  amount: { en: 'Amount', ur: 'رقم' },
  units: { en: 'Items', ur: 'کل آئٹمز' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی کل' },
  discount: { en: 'Discount', ur: 'رعایت' },
  transferDiscount: { en: 'Bank transfer discount', ur: 'بینک ٹرانسفر پر رعایت' },
  shipping: { en: 'Delivery charges', ur: 'ڈیلیوری چارجز' },
  codFee: { en: 'Cash on delivery fee', ur: 'کیش آن ڈیلیوری فیس' },
  total: { en: 'Total', ur: 'کل رقم' },
  paid: { en: 'Paid', ur: 'ادا شدہ' },
  refunded: { en: 'Refunded', ur: 'واپس کی گئی رقم' },
  balanceDue: { en: 'Balance due', ur: 'بقایا رقم' },
  thanks: { en: 'Thank you for your order!', ur: 'آپ کے آرڈر کا شکریہ!' },
  cancelled: { en: 'Cancelled', ur: 'منسوخ' },
  doNotShip: { en: 'Cancelled: do not ship', ur: 'منسوخ: مت بھیجیں' },
  doNotPack: { en: 'Not confirmed: do not pack yet', ur: 'تصدیق باقی ہے: ابھی پیک نہ کریں' },
  notPaid: { en: 'Not paid yet: do not pack', ur: 'ادائیگی باقی ہے: ابھی پیک نہ کریں' },
  shipped: { en: 'Already shipped', ur: 'بھیجا جا چکا ہے' },
  partlyShipped: {
    en: 'Partly shipped: the items left to ship',
    ur: 'کچھ آئٹمز جا چکے ہیں: باقی آئٹمز',
  },
} as const satisfies Record<string, Words>;

/** A packing slip: what to put in the parcel, where it goes, and the cash to collect. */
export function packingSlip(order: OrderRecord, context: DocumentContext): Html {
  const t = (words: Words) => say(context.language, words);
  const banner = packingWarning(order);
  const lines = linesToPack(order);
  const units = lines.reduce((sum, entry) => sum + entry.quantity, 0);
  const collect = order.amountPaid >= order.total ? 0n : order.codAmount;
  return html`
    ${banner && html`<p class="banner">${t(banner)}</p>`}
    ${header(order, context, WORDS.packingSlip)}
    <section class="columns">
      <div>
        <p class="label">${t(WORDS.shipTo)}</p>
        ${recipient(order, context)}
      </div>
      <div class="box">
        <p class="label">${t(WORDS.payment)}</p>
        <p>${t(paymentWords(order))}</p>
        ${
          collect > 0n
            ? html`<p>${t(WORDS.cashToCollect)}</p>
                <p class="big">${ltr(amount(order, collect))}</p>`
            : html`<p class="strong">${t(WORDS.nothingToCollect)}</p>`
        }
      </div>
    </section>
    <table class="lines">
      <thead>
        <tr>
          <th class="stack">${t(WORDS.item)}</th>
          <th class="num stack">${t(WORDS.quantity)}</th>
        </tr>
      </thead>
      <tbody>
        ${lines.map(
          ({ line, quantity }) =>
            html`<tr>
              <td>${item(line)}</td>
              <td class="num big">${ltr(String(quantity))}</td>
            </tr>`,
        )}
      </tbody>
    </table>
    <p class="strong">${t(WORDS.units)}: ${ltr(String(units))}</p>
    <p class="footer">${t(WORDS.thanks)}</p>
  `;
}

/** An invoice: what was bought at what price, what was paid and refunded, and what is left. */
export function invoice(order: OrderRecord, context: DocumentContext): Html {
  const t = (words: Words) => say(context.language, words);
  const price = (value: bigint) => ltr(amount(order, value));
  return html`
    ${order.stage === 'cancelled' && html`<p class="banner">${t(WORDS.cancelled)}</p>`}
    ${header(order, context, WORDS.invoice)}
    <section class="columns">
      <div>
        <p class="label">${t(WORDS.billTo)}</p>
        ${recipient(order, context)} ${order.email && html`<p>${text(order.email)}</p>`}
      </div>
      <div>
        <p class="label">${t(WORDS.payment)}</p>
        <p>${t(paymentWords(order))}</p>
      </div>
    </section>
    <table class="lines">
      <thead>
        <tr>
          <th class="stack">${t(WORDS.item)}</th>
          <th class="num stack">${t(WORDS.quantity)}</th>
          <th class="num stack">${t(WORDS.price)}</th>
          <th class="num stack">${t(WORDS.amount)}</th>
        </tr>
      </thead>
      <tbody>
        ${order.lines.map(
          (line) =>
            html`<tr>
              <td>${item(line)}</td>
              <td class="num">${ltr(String(line.quantity))}</td>
              <td class="num">${price(line.unitPrice)}</td>
              <td class="num">${price(line.total)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
    <table class="totals">
      <tbody>
        <tr>
          <td>${t(WORDS.subtotal)}</td>
          <td class="num">${price(order.subtotal)}</td>
        </tr>
        ${
          // The codes' or staff's, then what paying by transfer took off (ADR-077).
          order.discount > order.transferDiscount &&
          html`<tr>
            <td>${t(WORDS.discount)}</td>
            <td class="num">
              ${ltr(`-${amount(order, order.discount - order.transferDiscount)}`)}
            </td>
          </tr>`
        }
        ${
          order.transferDiscount > 0n &&
          html`<tr>
            <td>${t(WORDS.transferDiscount)}</td>
            <td class="num">${ltr(`-${amount(order, order.transferDiscount)}`)}</td>
          </tr>`
        }
        <tr>
          <td>${t(WORDS.shipping)}</td>
          <td class="num">${price(order.shipping)}</td>
        </tr>
        ${
          order.codFee > 0n &&
          html`<tr>
            <td>${t(WORDS.codFee)}</td>
            <td class="num">${price(order.codFee)}</td>
          </tr>`
        }
        <tr class="grand">
          <td>${t(WORDS.total)}</td>
          <td class="num">${price(order.total)}</td>
        </tr>
        ${
          // The sales tax its total includes, by rate (ADR-096): a tax line, never added on.
          [...taxByRate(order)].map(
            ([rate, tax]) =>
              html`<tr>
                <td>${t(taxIncludedWords(rate))}</td>
                <td class="num">${price(tax)}</td>
              </tr>`,
          )
        }
        ${
          order.amountPaid > 0n &&
          html`<tr>
            <td>${t(WORDS.paid)}</td>
            <td class="num">${price(order.amountPaid)}</td>
          </tr>`
        }
        ${
          order.amountRefunded > 0n &&
          html`<tr>
            <td>${t(WORDS.refunded)}</td>
            <td class="num">${price(order.amountRefunded)}</td>
          </tr>`
        }
        <tr class="grand">
          <td>${t(WORDS.balanceDue)}</td>
          <td class="num">${price(order.total - order.amountPaid)}</td>
        </tr>
      </tbody>
    </table>
    <p class="footer">${t(WORDS.thanks)}</p>
  `;
}

/** "Packing slip #1001", or "Packing slips: 3 orders", and a file name to save it as. */
export function documentName(
  kind: DocumentKindValue,
  numbers: readonly number[],
): { title: string; fileName: string } {
  const [one, many] =
    kind === 'invoice' ? ['Invoice', 'Invoices'] : ['Packing slip', 'Packing slips'];
  const slug = (words: string) => words.toLowerCase().replaceAll(' ', '-');
  if (numbers.length === 1) {
    const [number] = numbers as [number];
    return { title: `${one} ${orderName(number)}`, fileName: `${slug(one)}-${number}.html` };
  }
  const range = numbers.length > 0 ? `-${Math.min(...numbers)}-${Math.max(...numbers)}` : '';
  return {
    title: `${many}: ${numbers.length} orders`,
    fileName: `${slug(many)}${range}.html`,
  };
}

/** The shop, where the order ships from, and which order this is. */
function header(order: OrderRecord, context: DocumentContext, title: Words): Html {
  const from = context.from ? locationLines(context.from) : [];
  return html`<header class="header">
    <div>
      <h1 class="shop">${text(context.shop.name)}</h1>
      ${
        from.length > 0 &&
        html`<p class="small muted">
          ${from.map((line, index) => html`${index > 0 && html`<br />`}${text(line)}`)}
        </p>`
      }
    </div>
    <div class="meta">
      <h2 class="title">${say(context.language, title)}</h2>
      <p class="big">${ltr(orderName(order.number))}</p>
      <p>${ltr(formatDate(order.createdAt, context.shop.timezone))}</p>
    </div>
  </header>`;
}

/** Who the order goes to. An erased customer's order keeps only the city and province. */
function recipient(order: OrderRecord, context: DocumentContext): Html {
  const address = order.shippingAddress;
  return html`
    ${address.name && html`<p class="strong">${text(address.name)}</p>`}
    ${addressLines(address).map((line) => html`<p>${text(line)}</p>`)}
    ${context.phone && html`<p>${ltr(context.phone)}</p>`}
  `;
}

/** A line's product, then its variant and SKU. */
function item(line: OrderLineRecord): Html {
  const details = [
    line.variantTitle === DEFAULT_VARIANT_TITLE ? null : line.variantTitle,
    line.sku,
  ].filter((detail): detail is string => Boolean(detail));
  return html`<p>${text(line.title)}</p>
    ${
      details.length > 0 &&
      html`<p class="small muted">
        ${details.map((detail, index) => html`${index > 0 && ' · '}${text(detail)}`)}
      </p>`
    }`;
}

/**
 * What a packing slip lists: what is left to ship, or, once everything has shipped, all of it,
 * for a slip printed again.
 */
function linesToPack(order: OrderRecord): { line: OrderLineRecord; quantity: number }[] {
  const left = order.lines
    .map((line) => ({ line, quantity: line.quantity - line.fulfilledQuantity }))
    .filter((entry) => entry.quantity > 0);
  return left.length > 0 ? left : order.lines.map((line) => ({ line, quantity: line.quantity }));
}

/** A warning across the top of a packing slip for an order not to pack as usual. */
function packingWarning(order: OrderRecord): Words | null {
  if (order.stage === 'cancelled') return WORDS.doNotShip;
  if (order.stage === 'needs_confirmation' || order.stage === 'needs_review') {
    return WORDS.doNotPack;
  }
  if (order.stage === 'awaiting_payment') return WORDS.notPaid;
  if (order.fulfillmentStatus === 'unfulfilled') return null;
  return order.lines.some((line) => line.fulfilledQuantity < line.quantity)
    ? WORDS.partlyShipped
    : WORDS.shipped;
}

function paymentWords(order: OrderRecord): Words {
  switch (order.paymentMethod) {
    case 'cash_on_delivery':
      return WORDS.cashOnDelivery;
    case 'prepaid':
      return WORDS.prepaid;
    case 'bank_transfer':
      return WORDS.bankTransfer;
  }
}

function amount(order: OrderRecord, value: bigint): string {
  return formatMoney(money(value, order.currency as CurrencyCode));
}

/** "House 12, Street 4", "Gulshan-e-Iqbal", "Near Nipa Chowrangi", "Karachi 75300, Sindh". */
function addressLines(address: StoredAddressValue): string[] {
  return [address.address1, address.address2, address.landmark, cityLine(address)].filter(
    (line): line is string => Boolean(line),
  );
}

function locationLines(location: LocationRecord): string[] {
  const phone = location.address.phone ? parsePkMobile(location.address.phone)?.display : null;
  return [location.address.address1, cityLine(location.address), phone].filter(
    (line): line is string => Boolean(line),
  );
}

function cityLine(address: {
  city: string | null;
  zip: string | null;
  provinceCode: string | null;
}): string {
  const province = address.provinceCode
    ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
    : null;
  const city = [address.city, address.zip].filter(Boolean).join(' ');
  return [city, province].filter(Boolean).join(', ');
}

/** "29 Sep 2026", in the shop's time zone. (British English now shortens September to "Sept".) */
function formatDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

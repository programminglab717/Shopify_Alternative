import type { ShopProfile } from '@hatti/api';
import {
  code128,
  formatDay,
  html,
  isCode128,
  ltr,
  say,
  text,
  type Html,
  type Language,
  type Words,
} from '@hatti/documents';
import type { LocationRecord } from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import type { ParcelShipmentFacts } from '@hatti/orders/public';
import { parsePkMobile } from '@hatti/pk';

// Couriers' labels and load sheets (SHP-02, ADR-150): what packers print for the parcels the
// worker booked, in English and Urdu, as the order's other documents are.

const WORDS = {
  to: { en: 'To', ur: 'بنام' },
  from: { en: 'From', ur: 'بھیجنے والا' },
  order: { en: 'Order', ur: 'آرڈر' },
  cashToCollect: { en: 'Cash to collect', ur: 'وصول کی جانے والی رقم' },
  nothingToCollect: { en: 'Paid: nothing to collect', ur: 'ادا شدہ: کوئی رقم وصول نہیں کرنی' },
  pieces: { en: 'Pieces', ur: 'تعداد' },
  weight: { en: 'Weight', ur: 'وزن' },
  contents: { en: 'Contents', ur: 'سامان' },
  booked: { en: 'Booked', ur: 'بکنگ' },
  loadSheet: { en: 'Load sheet', ur: 'لوڈ شیٹ' },
  account: { en: 'Account', ur: 'اکاؤنٹ' },
  pickupCode: { en: 'Pickup code', ur: 'پک اپ کوڈ' },
  trackingNumber: { en: 'Tracking number', ur: 'ٹریکنگ نمبر' },
  customer: { en: 'Customer', ur: 'گاہک' },
  city: { en: 'City', ur: 'شہر' },
  cash: { en: 'Cash', ur: 'رقم' },
  parcels: { en: 'Parcels', ur: 'پارسل' },
  total: { en: 'Total', ur: 'کل' },
  handedOverBy: { en: 'Handed over by', ur: 'حوالے کرنے والا' },
  receivedBy: { en: "Received by the courier's rider", ur: 'وصول کرنے والا رائیڈر' },
  name: { en: 'Name', ur: 'نام' },
  signature: { en: 'Signature', ur: 'دستخط' },
  dateAndTime: { en: 'Date and time', ur: 'تاریخ اور وقت' },
} as const satisfies Record<string, Words>;

/** A booked parcel's label: the booking's, and its parcel's as the orders module tells it. */
export interface ParcelLabel {
  courierName: string;
  trackingNumber: string;
  /** Minor units: what the courier was asked to collect. */
  codAmount: bigint;
  bookedAt: Date;
  parcel: ParcelShipmentFacts & { address: NonNullable<ParcelShipmentFacts['address']> };
  /** The customer's number as the caller sees it, whole or masked. */
  phone: string | null;
}

/** What labels and load sheets need besides their parcels. */
export interface CourierDocumentContext {
  language: Language;
  shop: ShopProfile;
  currency: CurrencyCode;
  /** Where each parcel shipped from, by its location's ID. */
  locations: ReadonlyMap<string, LocationRecord>;
}

/**
 * A parcel's label: its courier and the courier's tracking number as a Code 128 barcode, the
 * order, who it goes to and where, the cash to collect, what is in it, and where it came from.
 */
export function shippingLabel(label: ParcelLabel, context: CourierDocumentContext): Html {
  const t = (words: Words) => say(context.language, words);
  const { parcel } = label;
  const address = parcel.address;
  const from = context.locations.get(parcel.locationId) ?? null;
  const pieces = parcel.items.reduce((sum, item) => sum + item.quantity, 0);
  const contents = parcel.items
    .map((item) => (item.quantity > 1 ? `${item.title} x ${item.quantity}` : item.title))
    .join(', ');
  return html`<div class="shipping-label">
    <header class="header">
      <p class="huge">${text(label.courierName)}</p>
      <div class="meta">
        <p class="label">${t(WORDS.order)}</p>
        <p class="big">${ltr(`#${parcel.orderNumber}`)}</p>
      </div>
    </header>
    ${isCode128(label.trackingNumber) && code128(label.trackingNumber)}
    <p class="big footer">${ltr(label.trackingNumber)}</p>
    <hr class="rule" />
    <p class="label">${t(WORDS.to)}</p>
    <p class="big">${text(address.name)}</p>
    ${[address.address1, address.address2, address.landmark].map(
      (line) => line && html`<p>${text(line)}</p>`,
    )}
    <p class="huge">${text(address.city)}</p>
    ${label.phone && html`<p class="strong">${ltr(label.phone)}</p>`}
    <hr class="rule" />
    ${
      label.codAmount > 0n
        ? html`<div class="box">
            <p class="label">${t(WORDS.cashToCollect)}</p>
            <p class="huge">${ltr(amount(label.codAmount, context.currency))}</p>
          </div>`
        : html`<p class="banner">${t(WORDS.nothingToCollect)}</p>`
    }
    <p>
      ${t(WORDS.pieces)}: ${ltr(String(pieces))}
      ${parcel.weightGrams !== null && html` · ${t(WORDS.weight)}: ${ltr(weight(parcel.weightGrams))}`}
    </p>
    <p class="small">${t(WORDS.contents)}: ${text(contents)}</p>
    <hr class="rule" />
    <p class="label">${t(WORDS.from)}</p>
    <p class="strong">${text(context.shop.name)}</p>
    ${from && html`<p class="small">${locationLines(from).map((line, index) => html`${index > 0 && ', '}${text(line)}`)}</p>`}
    <p class="small muted">
      ${t(WORDS.booked)}: ${ltr(formatDay(label.bookedAt, context.shop.timezone))}
    </p>
  </div>`;
}

/** A row of a load sheet: a parcel handed to the courier. */
export interface LoadSheetRow {
  trackingNumber: string;
  orderNumber: number;
  /** Null once the customer's details were erased. */
  customer: string | null;
  city: string | null;
  pieces: number;
  codAmount: bigint;
}

/**
 * A load sheet (SHP-02): the parcels a courier account's rider picks up, with their cash, and
 * boxes for the shop and the rider to sign as they change hands.
 */
export function loadSheet(
  rows: readonly LoadSheetRow[],
  sheet: {
    account: { name: string; courierName: string; pickupCode: string | null };
    at: Date;
    from: LocationRecord | null;
  },
  context: CourierDocumentContext,
): Html {
  const t = (words: Words) => say(context.language, words);
  const total = rows.reduce((sum, row) => sum + row.codAmount, 0n);
  const pieces = rows.reduce((sum, row) => sum + row.pieces, 0);
  return html`
    <header class="header">
      <div>
        <h1 class="shop">${text(context.shop.name)}</h1>
        ${
          sheet.from &&
          html`<p class="small muted">
            ${locationLines(sheet.from).map((line, index) => html`${index > 0 && html`<br />`}${text(line)}`)}
          </p>`
        }
      </div>
      <div class="meta">
        <h2 class="title">${t(WORDS.loadSheet)}</h2>
        <p class="big">${text(sheet.account.courierName)}</p>
        <p>${t(WORDS.account)}: ${text(sheet.account.name)}</p>
        ${
          sheet.account.pickupCode &&
          html`<p>${t(WORDS.pickupCode)}: ${ltr(sheet.account.pickupCode)}</p>`
        }
        <p>${ltr(formatDay(sheet.at, context.shop.timezone))}</p>
      </div>
    </header>
    <table class="lines">
      <thead>
        <tr>
          <th class="num">#</th>
          <th class="stack">${t(WORDS.trackingNumber)}</th>
          <th class="stack">${t(WORDS.order)}</th>
          <th class="stack">${t(WORDS.customer)}</th>
          <th class="stack">${t(WORDS.city)}</th>
          <th class="num stack">${t(WORDS.pieces)}</th>
          <th class="num stack">${t(WORDS.cash)}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row, index) =>
            html`<tr>
              <td class="num">${ltr(String(index + 1))}</td>
              <td class="strong">${ltr(row.trackingNumber)}</td>
              <td>${ltr(`#${row.orderNumber}`)}</td>
              <td>${text(row.customer ?? '-')}</td>
              <td>${text(row.city ?? '-')}</td>
              <td class="num">${ltr(String(row.pieces))}</td>
              <td class="num">${ltr(amount(row.codAmount, context.currency))}</td>
            </tr>`,
        )}
      </tbody>
    </table>
    <table class="totals">
      <tbody>
        <tr>
          <td>${t(WORDS.parcels)}</td>
          <td class="num">${ltr(String(rows.length))}</td>
        </tr>
        <tr>
          <td>${t(WORDS.pieces)}</td>
          <td class="num">${ltr(String(pieces))}</td>
        </tr>
        <tr class="grand">
          <td>${t(WORDS.cashToCollect)}</td>
          <td class="num">${ltr(amount(total, context.currency))}</td>
        </tr>
      </tbody>
    </table>
    <section class="signatures">
      ${[WORDS.handedOverBy, WORDS.receivedBy].map(
        (who) =>
          html`<div class="box">
            <p class="strong">${t(who)}</p>
            <p class="small">${t(WORDS.name)}:</p>
            <p class="small">${t(WORDS.signature)}:</p>
            <p class="small">${t(WORDS.dateAndTime)}:</p>
          </div>`,
      )}
    </section>
  `;
}

function amount(value: bigint, currency: CurrencyCode): string {
  return formatMoney(money(value, currency));
}

/** "900 g", "1.25 kg". */
function weight(grams: number): string {
  return grams < 1_000 ? `${grams} g` : `${Number((grams / 1_000).toFixed(2))} kg`;
}

/** Where a parcel came from: the location's street, its city, and its number. */
function locationLines(location: LocationRecord): string[] {
  const phone = location.address.phone
    ? (parsePkMobile(location.address.phone)?.display ?? location.address.phone)
    : null;
  return [location.address.address1, location.address.city, phone].filter((line): line is string =>
    Boolean(line),
  );
}

import type { ShopProfile } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import {
  formatDay,
  html,
  ltr,
  renderDocument,
  say,
  text,
  type Html,
  type Language,
  type Words,
} from '@hatti/documents';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, parsePkMobile, type PkProvinceCode } from '@hatti/pk';
import type { PurchaseOrderLineRecord, PurchaseOrderRecord } from './purchase-order.service.js';
import type { LocationRecord } from './records.js';

// Wording for a purchase order sent to a supplier, in English and Urdu.
const WORDS = {
  purchaseOrder: { en: 'Purchase order', ur: 'خریداری آرڈر' },
  supplier: { en: 'Supplier', ur: 'سپلائر' },
  deliverTo: { en: 'Deliver to', ur: 'مال یہاں پہنچائیں' },
  expected: { en: 'Expected by', ur: 'متوقع تاریخ' },
  yourReference: { en: 'Your reference', ur: 'آپ کا حوالہ' },
  item: { en: 'Item', ur: 'آئٹم' },
  quantity: { en: 'Qty', ur: 'تعداد' },
  unitCost: { en: 'Each', ur: 'فی عدد' },
  amount: { en: 'Amount', ur: 'رقم' },
  units: { en: 'Items', ur: 'کل آئٹمز' },
  total: { en: 'Total', ur: 'کل رقم' },
  note: { en: 'Note', ur: 'نوٹ' },
  received: { en: 'Received', ur: 'موصول' },
  closed: { en: 'Closed', ur: 'بند' },
  thanks: {
    en: 'Please send these goods to the address above.',
    ur: 'براہ کرم یہ مال اوپر دیے گئے پتے پر بھیج دیں۔',
  },
} as const satisfies Record<string, Words>;

export interface PurchaseOrderDocumentContext {
  language: Language;
  shop: ShopProfile;
  currency: CurrencyCode;
}

/** "PO-12", as a supplier is told it. */
export const purchaseOrderName = (number: number) => `PO-${number}`;

/**
 * A purchase order to send to its supplier: the shop, which order and when, where the goods go
 * and by when, and each line, with what it costs where the shop said; on A4, a page.
 */
export function purchaseOrderDocument(
  order: PurchaseOrderRecord,
  context: PurchaseOrderDocumentContext,
): { html: string; title: string; fileName: string } {
  const name = purchaseOrderName(order.number);
  return {
    html: renderDocument({
      title: `Purchase order ${name}`,
      paper: 'a4',
      language: context.language,
      pages: [page(order, context)],
    }),
    title: `Purchase order ${name}`,
    fileName: `purchase-order-${order.number}.html`,
  };
}

function page(order: PurchaseOrderRecord, context: PurchaseOrderDocumentContext): Html {
  const t = (words: Words) => say(context.language, words);
  const price = (value: bigint) => ltr(formatMoney(money(value, context.currency)));
  const costed = order.lines.some((line) => line.unitCost !== null);
  const units = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = order.lines.reduce(
    (sum, line) => sum + (line.unitCost ?? 0n) * BigInt(line.quantity),
    0n,
  );
  const ended =
    order.status === 'received' ? WORDS.received : order.status === 'closed' ? WORDS.closed : null;
  return html`
    ${ended && html`<p class="banner">${t(ended)}</p>`}
    <header class="header">
      <div>
        <h1 class="shop">${text(context.shop.name)}</h1>
      </div>
      <div class="meta">
        <h2 class="title">${t(WORDS.purchaseOrder)}</h2>
        <p class="big">${ltr(purchaseOrderName(order.number))}</p>
        <p>${ltr(formatDay(order.createdAt, context.shop.timezone))}</p>
      </div>
    </header>
    <section class="columns">
      <div>
        <p class="label">${t(WORDS.supplier)}</p>
        <p class="strong">${text(order.supplier.name)}</p>
        ${order.supplier.phone && html`<p>${ltr(phone(order.supplier.phone))}</p>`}
        ${
          order.reference &&
          html`<p class="small">${t(WORDS.yourReference)}: ${ltr(order.reference)}</p>`
        }
      </div>
      <div class="box">
        <p class="label">${t(WORDS.deliverTo)}</p>
        <p class="strong">${text(order.location.name)}</p>
        ${locationLines(order.location).map((line) => html`<p>${text(line)}</p>`)}
        ${
          order.expectedOn &&
          html`<p>
            ${t(WORDS.expected)}:
            ${ltr(formatDay(new Date(`${order.expectedOn}T12:00:00Z`), 'UTC'))}
          </p>`
        }
      </div>
    </section>
    <table class="lines">
      <thead>
        <tr>
          <th class="stack">${t(WORDS.item)}</th>
          <th class="num stack">${t(WORDS.quantity)}</th>
          ${costed && html`<th class="num stack">${t(WORDS.unitCost)}</th>`}
          ${costed && html`<th class="num stack">${t(WORDS.amount)}</th>`}
        </tr>
      </thead>
      <tbody>
        ${order.lines.map(
          (line) =>
            html`<tr>
              <td>${item(line)}</td>
              <td class="num big">${ltr(String(line.quantity))}</td>
              ${costed && html`<td class="num">${line.unitCost !== null && price(line.unitCost)}</td>`}
              ${
                costed &&
                html`<td class="num">
                  ${line.unitCost !== null && price(line.unitCost * BigInt(line.quantity))}
                </td>`
              }
            </tr>`,
        )}
      </tbody>
    </table>
    <table class="totals">
      <tbody>
        <tr>
          <td>${t(WORDS.units)}</td>
          <td class="num">${ltr(String(units))}</td>
        </tr>
        ${
          costed &&
          html`<tr class="grand">
            <td>${t(WORDS.total)}</td>
            <td class="num">${price(total)}</td>
          </tr>`
        }
      </tbody>
    </table>
    ${order.note && html`<p class="small"><span class="strong">${t(WORDS.note)}:</span> ${text(order.note)}</p>`}
    <p class="footer">${t(WORDS.thanks)}</p>
  `;
}

/** A line's product, then its variant and SKU. */
function item(line: PurchaseOrderLineRecord): Html {
  const details = [
    line.variantTitle === DEFAULT_VARIANT_TITLE ? null : line.variantTitle,
    line.sku,
  ].filter((detail): detail is string => Boolean(detail));
  return html`<p>${text(line.productTitle)}</p>
    ${
      details.length > 0 &&
      html`<p class="small muted">
        ${details.map((detail, index) => html`${index > 0 && ' · '}${text(detail)}`)}
      </p>`
    }`;
}

/** "0300 7654321", as people write a number. */
function phone(e164: string): string {
  return parsePkMobile(e164)?.display ?? e164;
}

/** "Plot 5, Sundar Estate", "Lahore 54000, Punjab", "0300 1234567". */
function locationLines(location: LocationRecord): string[] {
  const { address1, address2, city, zip, provinceCode } = location.address;
  const province = provinceCode ? PK_PROVINCES[provinceCode as PkProvinceCode].name : null;
  const cityLine = [[city, zip].filter(Boolean).join(' '), province].filter(Boolean).join(', ');
  const number = location.address.phone ? phone(location.address.phone) : null;
  return [address1, address2, cityLine, number].filter((line): line is string => Boolean(line));
}

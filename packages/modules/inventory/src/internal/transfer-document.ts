import type { ShopProfile } from '@hatti/api';
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
import { item, locationLines } from './purchase-order-document.js';
import type { TransferRecord } from './transfer.service.js';

// Wording for a transfer that goes with the stock, in English and Urdu.
const WORDS = {
  transfer: { en: 'Stock transfer', ur: 'اسٹاک کی منتقلی' },
  from: { en: 'From', ur: 'کہاں سے' },
  to: { en: 'To', ur: 'کہاں' },
  reference: { en: 'Tracking or bilty', ur: 'ٹریکنگ یا بلٹی' },
  item: { en: 'Item', ur: 'آئٹم' },
  sent: { en: 'Sent', ur: 'بھیجے' },
  arrived: { en: 'Arrived', ur: 'پہنچے' },
  units: { en: 'Items', ur: 'کل آئٹمز' },
  note: { en: 'Note', ur: 'نوٹ' },
  received: { en: 'Received', ur: 'موصول' },
  cancelled: { en: 'Cancelled', ur: 'منسوخ' },
  sentBy: { en: 'Sent by', ur: 'بھیجنے والا' },
  receivedBy: { en: 'Received by', ur: 'وصول کرنے والا' },
  name: { en: 'Name', ur: 'نام' },
  signature: { en: 'Signature', ur: 'دستخط' },
  dateAndTime: { en: 'Date and time', ur: 'تاریخ اور وقت' },
  count: {
    en: 'Count each item as it arrives and write how many came.',
    ur: 'ہر آئٹم پہنچنے پر گنیں اور لکھیں کہ کتنے آئے۔',
  },
} as const satisfies Record<string, Words>;

export interface TransferDocumentContext {
  language: Language;
  shop: ShopProfile;
}

/** "T-4", as the shop names it. */
export const transferName = (number: number) => `T-${number}`;

/**
 * A transfer to go with the stock (ADR-362): the shop, which transfer and when it was sent, where
 * it leaves and where it goes, and each line, with room to write how many arrived and to sign at
 * both ends; on A4, a page.
 */
export function transferDocument(
  transfer: TransferRecord,
  context: TransferDocumentContext,
): { html: string; title: string; fileName: string } {
  const name = transferName(transfer.number);
  return {
    html: renderDocument({
      title: `Stock transfer ${name}`,
      paper: 'a4',
      language: context.language,
      pages: [page(transfer, context)],
    }),
    title: `Stock transfer ${name}`,
    fileName: `transfer-${transfer.number}.html`,
  };
}

function page(transfer: TransferRecord, context: TransferDocumentContext): Html {
  const t = (words: Words) => say(context.language, words);
  const units = transfer.lines.reduce((sum, line) => sum + line.quantity, 0);
  const ended =
    transfer.status === 'received'
      ? WORDS.received
      : transfer.status === 'cancelled'
        ? WORDS.cancelled
        : null;
  return html`
    ${ended && html`<p class="banner">${t(ended)}</p>`}
    <header class="header">
      <div>
        <h1 class="shop">${text(context.shop.name)}</h1>
      </div>
      <div class="meta">
        <h2 class="title">${t(WORDS.transfer)}</h2>
        <p class="big">${ltr(transferName(transfer.number))}</p>
        <p>${ltr(formatDay(transfer.createdAt, context.shop.timezone))}</p>
        ${
          transfer.reference &&
          html`<p class="small">${t(WORDS.reference)}: ${ltr(transfer.reference)}</p>`
        }
      </div>
    </header>
    <section class="columns">
      ${[
        [WORDS.from, transfer.origin],
        [WORDS.to, transfer.destination],
      ].map(
        ([label, location]) =>
          html`<div class="box">
            <p class="label">${t(label as Words)}</p>
            <p class="strong">${text((location as TransferRecord['origin']).name)}</p>
            ${locationLines(location as TransferRecord['origin']).map(
              (line) => html`<p>${text(line)}</p>`,
            )}
          </div>`,
      )}
    </section>
    <table class="lines">
      <thead>
        <tr>
          <th class="stack">${t(WORDS.item)}</th>
          <th class="num stack">${t(WORDS.sent)}</th>
          <th class="num stack">${t(WORDS.arrived)}</th>
        </tr>
      </thead>
      <tbody>
        ${transfer.lines.map(
          (line) =>
            html`<tr>
              <td>${item(line)}</td>
              <td class="num big">${ltr(String(line.quantity))}</td>
              <td class="num">${line.received > 0 && ltr(String(line.received))}</td>
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
      </tbody>
    </table>
    ${transfer.note && html`<p class="small"><span class="strong">${t(WORDS.note)}:</span> ${text(transfer.note)}</p>`}
    <p class="small">${t(WORDS.count)}</p>
    <section class="signatures">
      ${[WORDS.sentBy, WORDS.receivedBy].map(
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

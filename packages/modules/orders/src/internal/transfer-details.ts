import { html, ltr, say, text, type Html, type HtmlValue, type Words } from '@hatti/documents';
import { formatMoney, money } from '@hatti/money';
import { formatIban } from '@hatti/pk';
import type { OrderRecord } from './records.js';
import { orderName } from './rules.js';

const WORDS = {
  payByTransfer: { en: 'Pay by bank transfer', ur: 'بینک ٹرانسفر سے ادائیگی' },
  accountTitle: { en: 'Account title', ur: 'اکاؤنٹ ٹائٹل' },
  bank: { en: 'Bank', ur: 'بینک' },
  iban: { en: 'IBAN', ur: 'آئی بی اے این' },
  amount: { en: 'Amount', ur: 'رقم' },
  reference: { en: 'Reference', ur: 'ریفرنس' },
} satisfies Record<string, Words>;

/** What a bank-transfer order still waits for, as "Rs 5,000". */
function owedOf(order: OrderRecord): string {
  return formatMoney(money(order.total - order.amountPaid, order.currency));
}

/**
 * What a customer whose bank-transfer order waits for its money is told to do (ADR-074): pay what
 * it still waits for, with its name as the transfer's reference; and, when the shop gave no
 * account, to ask for one. In English and Urdu, for the checkout's thank-you page and the order's
 * link alike.
 */
export function transferWords(order: OrderRecord, shopName: string): { en: string; ur: Html } {
  const name = orderName(order.number);
  const owed = owedOf(order);
  const ask = !order.bankAccount;
  return {
    en:
      `Your order ${name} is placed. Pay ${owed} by bank transfer, with ${name} as the ` +
      `reference: ${shopName} sends your order once the money is in.` +
      (ask ? ` Ask ${shopName} in your chat for their account.` : ''),
    ur: html`آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ ${ltr(owed)} بینک ٹرانسفر سے ادا کریں اور
    ریفرنس میں ${ltr(name)} لکھیں: رقم ملتے ہی دکان آپ کا آرڈر بھیج دے
    گی۔${ask && ' اکاؤنٹ کی تفصیل کے لیے اپنی چیٹ میں دکان سے پوچھیں۔'}`,
  };
}

/**
 * Where a bank-transfer order is paid (ADR-074): the account its customer was told, what the order
 * still waits for, its name as the transfer's reference, and what the shop says besides. The IBAN
 * is grouped in fours, and selected whole with a tap, to copy. Only while the order waits for the
 * money: not while it is held for review, which may cancel it, nor once paid or cancelled; and
 * nothing for an order whose shop gave no account.
 */
export function transferDetails(order: OrderRecord): Html {
  const account = order.bankAccount;
  if (!account || order.stage !== 'awaiting_payment') return html``;
  const row = (label: Words, value: HtmlValue, className = 'num') =>
    html`<tr>
      <td>${say('bilingual', label)}</td>
      <td class="${className}">${value}</td>
    </tr>`;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', WORDS.payByTransfer)}</h2>
    <table>
      ${row(WORDS.accountTitle, text(account.title), 'num wrap')}
      ${row(WORDS.bank, text(account.bankName), 'num wrap')}
      ${row(
        WORDS.iban,
        html`<bdi dir="ltr" class="select-all">${formatIban(account.iban)}</bdi>`,
        'num wrap',
      )}
      ${row(WORDS.amount, ltr(owedOf(order)))} ${row(WORDS.reference, ltr(orderName(order.number)))}
    </table>
    ${account.instructions && html`<p class="small">${text(account.instructions)}</p>`}
  </section>`;
}

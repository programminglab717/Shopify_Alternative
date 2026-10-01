import { html, ltr, say, text, type Html, type HtmlValue, type Words } from '@hatti/documents';
import { formatMoney, money } from '@hatti/money';
import { formatIban, parsePkMobile } from '@hatti/pk';
import type { OrderRecord } from './records.js';
import { orderName, transferOwed } from './rules.js';

const WORDS = {
  payByTransfer: { en: 'Pay by bank transfer', ur: 'بینک ٹرانسفر سے ادائیگی' },
  advanceByTransfer: {
    en: 'Pay the advance by bank transfer',
    ur: 'ایڈوانس کی بینک ٹرانسفر سے ادائیگی',
  },
  accountTitle: { en: 'Account title', ur: 'اکاؤنٹ ٹائٹل' },
  bank: { en: 'Bank', ur: 'بینک' },
  iban: { en: 'IBAN', ur: 'آئی بی اے این' },
  raastId: { en: 'Raast ID', ur: 'راست آئی ڈی' },
  amount: { en: 'Amount', ur: 'رقم' },
  reference: { en: 'Reference', ur: 'ریفرنس' },
} satisfies Record<string, Words>;

/** A Raast ID as people write mobile numbers: "0300 1234567". */
function nationalOf(e164: string): string {
  const national = parsePkMobile(e164)?.national ?? e164;
  return `${national.slice(0, 4)} ${national.slice(4)}`;
}

/**
 * What an order waits for by transfer, as "Rs 5,000": a bank-transfer order, the rest of its
 * total; a cash-on-delivery order, its advance.
 */
function owedOf(order: OrderRecord): string {
  return formatMoney(money(transferOwed(order), order.currency));
}

/**
 * What a customer whose bank-transfer order waits for its money is told to do (ADR-074): pay what
 * it still waits for, with its name as the transfer's reference; and, when the shop gave no
 * account, to ask for one. A cash-on-delivery order's customer is told to pay its advance so
 * (ADR-083), the rest at the door. In English and Urdu, for the checkout's thank-you page and the
 * order's link alike.
 */
export function transferWords(order: OrderRecord, shopName: string): { en: string; ur: Html } {
  const name = orderName(order.number);
  const owed = owedOf(order);
  const ask = !order.bankAccount;
  if (order.paymentMethod === 'cash_on_delivery') {
    return {
      en:
        `Your order ${name} is placed. Pay ${owed} in advance by bank transfer, with ${name} as ` +
        `the reference: ${shopName} sends your order once it is in.`,
      ur: html`آپ کا آرڈر ${ltr(name)} موصول ہو گیا ہے۔ ${ltr(owed)} ایڈوانس بینک ٹرانسفر سے ادا
      کریں اور ریفرنس میں ${ltr(name)} لکھیں: ایڈوانس ملتے ہی دکان آپ کا آرڈر بھیج دے گی۔`,
    };
  }
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
 * Where a bank-transfer order, or a cash-on-delivery order's advance (ADR-083), is paid (ADR-074):
 * the account its customer was told, with its Raast ID where it has one (ADR-082), what the order
 * still waits for, its name as the transfer's
 * reference, and what the shop says besides. The IBAN is grouped in fours, and it and the Raast
 * ID are selected whole with a tap, to copy. Only while the order waits for the money: not while
 * it is held for review, which may cancel it, nor once paid or cancelled; and nothing for an order
 * whose shop gave no account.
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
    <h2 class="label">
      ${say(
        'bilingual',
        order.paymentMethod === 'cash_on_delivery' ? WORDS.advanceByTransfer : WORDS.payByTransfer,
      )}
    </h2>
    <table>
      ${row(WORDS.accountTitle, text(account.title), 'num wrap')}
      ${row(WORDS.bank, text(account.bankName), 'num wrap')}
      ${row(
        WORDS.iban,
        html`<bdi dir="ltr" class="select-all">${formatIban(account.iban)}</bdi>`,
        'num wrap',
      )}
      ${
        account.raastId &&
        row(
          WORDS.raastId,
          html`<bdi dir="ltr" class="select-all">${nationalOf(account.raastId)}</bdi>`,
        )
      }
      ${row(WORDS.amount, ltr(owedOf(order)))} ${row(WORDS.reference, ltr(orderName(order.number)))}
    </table>
    ${account.instructions && html`<p class="small">${text(account.instructions)}</p>`}
  </section>`;
}

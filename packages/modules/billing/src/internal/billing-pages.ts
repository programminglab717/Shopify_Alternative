import {
  html,
  ltr,
  renderPage,
  say,
  text,
  type Html,
  type HtmlValue,
  type Words,
} from '@hatti/documents';
import { formatIban, parsePkMobile } from '@hatti/pk';
import { rupees, type HattiBankAccount, type InvoicePageView } from './billing.service.js';

// An invoice's page on the API's own address (ADR-154): where Hatti's gateway sends the shop's
// owner back once they paid, saying whether the invoice is paid, in English and Urdu: for a plan,
// or for message credit (ADR-155). While it is open, Hatti's own account to pay it into by
// transfer or Raast, where the host set one up (ADR-254).

const TITLE: Words = { en: 'Invoice', ur: 'انوائس' };
const NOT_FOUND: Words = { en: "This invoice isn't here", ur: 'یہ انوائس موجود نہیں' };

const WORDS = {
  payByTransfer: { en: 'Pay by bank transfer or Raast', ur: 'بینک ٹرانسفر یا راست سے ادائیگی' },
  accountTitle: { en: 'Account title', ur: 'اکاؤنٹ ٹائٹل' },
  bank: { en: 'Bank', ur: 'بینک' },
  iban: { en: 'IBAN', ur: 'آئی بی اے این' },
  raastId: { en: 'Raast ID', ur: 'راست آئی ڈی' },
  amount: { en: 'Amount', ur: 'رقم' },
  remarks: { en: 'Remarks', ur: 'ریمارکس' },
} satisfies Record<string, Words>;

/** The invoice's page, with its status; a page saying it isn't here for none. */
export function invoicePage(view: InvoicePageView | null): {
  status: number;
  html: string;
  contentSecurityPolicy: string;
} {
  if (!view) {
    const page = renderPage({
      title: NOT_FOUND.en,
      body: html`<h1 class="title stack">${say('bilingual', NOT_FOUND)}</h1>`,
    });
    return { status: 404, ...page };
  }
  const { invoice } = view;
  const name = invoice.name;
  const amount = rupees(invoice.amount);
  const plan = invoice.plan;
  const what = plan
    ? `${plan.name}, ${invoice.interval === 'yearly' ? 'yearly' : 'monthly'}`
    : 'message credit';
  let body: Html;
  if (invoice.status === 'paid') {
    const after = !plan
      ? ` ${amount} of message credit is added to ${view.shopName}'s.`
      : view.periodEnd
        ? ` ${view.shopName} is on ${plan.name} until ${dateOf(view.periodEnd)}.`
        : '';
    body = html`<div class="banner done" role="status">
      ${paragraphs({
        en: `Thank you: invoice ${name} is paid.${after}`,
        ur: plan
          ? html`شکریہ! انوائس ${ltr(name)} ادا ہو گئی ہے۔`
          : html`شکریہ! انوائس ${ltr(name)} ادا ہو گئی ہے، اور ${ltr(amount)} کا میسج کریڈٹ شامل ہو
            گیا ہے۔`,
      })}
    </div>`;
  } else if (invoice.status === 'open') {
    body = html`${paragraphs({
      en: `Invoice ${name}: ${amount} for ${what}. It waits for its payment: pay it from Hatti's admin.`,
      ur: html`انوائس ${ltr(name)}: ${ltr(amount)}۔ اس کی ادائیگی باقی ہے: ہٹی کے ایڈمن سے ادا کریں۔`,
    })}
    ${view.bank && transferDetails(view.bank, name, amount)}`;
  } else {
    body = paragraphs({
      en: `Invoice ${name} is no longer due.`,
      ur: html`انوائس ${ltr(name)} اب واجب الادا نہیں۔`,
    });
  }
  const page = renderPage({
    title: `${TITLE.en} ${name}`,
    body: html`<h1 class="title stack">${say('bilingual', TITLE)} ${ltr(name)}</h1>
      ${body}`,
  });
  return { status: 200, ...page };
}

/**
 * Where an open invoice is paid by transfer or Raast (ADR-254): Hatti's own account, with its
 * Raast ID where it has one, what the invoice asks for, and its name for the transfer's remarks;
 * then the owner gives the transfer's reference in Hatti's admin, for Hatti's people to find it.
 * The IBAN is grouped in fours, and it and the Raast ID are selected whole with a tap, to copy.
 */
function transferDetails(bank: HattiBankAccount, name: string, amount: string): Html {
  const row = (label: Words, value: HtmlValue, className = 'num') =>
    html`<tr>
      <td>${say('bilingual', label)}</td>
      <td class="${className}">${value}</td>
    </tr>`;
  return html`<section class="section">
    <h2 class="label">${say('bilingual', WORDS.payByTransfer)}</h2>
    <table>
      ${row(WORDS.accountTitle, text(bank.title), 'num wrap')}
      ${row(WORDS.bank, text(bank.bankName), 'num wrap')}
      ${row(
        WORDS.iban,
        html`<bdi dir="ltr" class="select-all">${formatIban(bank.iban)}</bdi>`,
        'num wrap',
      )}
      ${
        bank.raastId &&
        row(
          WORDS.raastId,
          html`<bdi dir="ltr" class="select-all">${nationalOf(bank.raastId)}</bdi>`,
        )
      }
      ${row(WORDS.amount, ltr(amount))} ${row(WORDS.remarks, ltr(name))}
    </table>
    ${paragraphs({
      en:
        `Write ${name} in the transfer's remarks. Then give the reference your bank or Raast ` +
        "gave the transfer in Hatti's admin: the invoice is paid once Hatti finds it in its account.",
      ur: html`ٹرانسفر کے ریمارکس میں ${ltr(name)} لکھیں۔ پھر ہٹی کے ایڈمن میں وہ ریفرنس درج کریں جو
      آپ کے بینک یا راست نے ٹرانسفر کو دیا: رقم ہٹی کے اکاؤنٹ میں ملتے ہی انوائس ادا ہو جائے گی۔`,
    })}
  </section>`;
}

/** A Raast ID as people write mobile numbers: "0300 1234567". */
function nationalOf(e164: string): string {
  const national = parsePkMobile(e164)?.national ?? e164;
  return `${national.slice(0, 4)} ${national.slice(4)}`;
}

/** "2 November 2026", in Pakistan's time. */
function dateOf(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Karachi',
  });
}

/** A sentence in English, then in Urdu, right to left. */
function paragraphs(sentence: { en: HtmlValue; ur: HtmlValue }): Html {
  return html`<div class="text">
    <p lang="en">${sentence.en}</p>
    <p lang="ur" dir="rtl">${sentence.ur}</p>
  </div>`;
}

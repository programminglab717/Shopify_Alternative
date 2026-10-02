import {
  html,
  ltr,
  renderPage,
  say,
  type Html,
  type HtmlValue,
  type Words,
} from '@hatti/documents';
import { rupees, type InvoicePageView } from './billing.service.js';

// An invoice's page on the API's own address (ADR-154): where Hatti's gateway sends the shop's
// owner back once they paid, saying whether the invoice is paid, in English and Urdu: for a plan,
// or for message credit (ADR-155).

const TITLE: Words = { en: 'Invoice', ur: 'انوائس' };
const NOT_FOUND: Words = { en: "This invoice isn't here", ur: 'یہ انوائس موجود نہیں' };

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
    body = paragraphs({
      en: `Invoice ${name}: ${amount} for ${what}. It waits for its payment: pay it from Hatti's admin.`,
      ur: html`انوائس ${ltr(name)}: ${ltr(amount)}۔ اس کی ادائیگی باقی ہے: ہٹی کے ایڈمن سے ادا کریں۔`,
    });
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

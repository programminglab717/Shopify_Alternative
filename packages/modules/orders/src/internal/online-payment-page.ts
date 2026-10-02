import { html, ltr, say, text, type Html, type HtmlValue, type Words } from '@hatti/documents';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import type { OnlineGateway } from './online-payments.js';

// Paying an order online on the pages customers see (ADR-151, ADR-152): the order's own page and
// checkout's thank-you page say it alike, in English and Urdu.

const PAY_ONLINE: Words = { en: 'Pay online', ur: 'آن لائن ادائیگی کریں' };

/** Why paying online did not go as the customer meant it to. */
export type OnlinePaymentProblem = 'unavailable' | 'pending' | 'test';

/**
 * Pays what the order waits for online, through the shop's gateway: a button posting
 * `action=pay` to the page, which answers with the gateway's page; through which gateway, and,
 * where `transfer`, a transfer to the account below as the other way.
 */
export function payOnlineForm(
  online: { gateway: OnlineGateway; amount: bigint },
  currency: CurrencyCode,
  transfer: boolean,
): Html {
  const due = formatMoney(money(online.amount, currency));
  return html`<form method="post">
    <input type="hidden" name="action" value="pay" />
    <button class="button stack" type="submit">${say('bilingual', PAY_ONLINE)}</button>
    ${paragraphs(
      {
        en:
          `Pay ${due} by card or wallet, through ${online.gateway.name}.` +
          (transfer ? ' Or transfer it to the account below.' : ''),
        ur: html`${ltr(due)} کارڈ یا والیٹ سے ${text(online.gateway.name)} کے ذریعے ادا
        کریں۔${transfer && ' یا نیچے دیے گئے اکاؤنٹ میں ٹرانسفر کریں۔'}`,
      },
      'center small muted',
    )}
  </form>`;
}

/** The customer came back from paying online, and the shop's gateway said it is in. */
export function onlinePaidNotice(shopName: string): Html {
  return html`<div class="banner done" role="status">
    ${paragraphs(
      {
        en: `Thank you: your payment is in, and ${shopName} will send your order soon.`,
        ur: 'شکریہ! آپ کی ادائیگی مل گئی ہے، اور آرڈر جلد بھیج دیا جائے گا۔',
      },
      '',
    )}
  </div>`;
}

/**
 * Why paying online did not go as meant: the gateway would not start it, its payment is not in
 * yet, or it was a test in the shop's sandbox. Where `transfer`, a transfer is the other way.
 */
export function onlinePaymentProblemWords(
  problem: OnlinePaymentProblem,
  transfer: boolean,
): { en: string; ur: string } {
  switch (problem) {
    case 'pending':
      return {
        en: "We haven't heard yet that your payment went through. If you paid, this page shows it soon.",
        ur: 'ابھی تک آپ کی ادائیگی کی تصدیق نہیں ہوئی۔ اگر آپ نے ادائیگی کی ہے تو یہ صفحہ جلد دکھا دے گا۔',
      };
    case 'test':
      return {
        en: "That was a test payment, in the shop's test account: nothing was paid, and the order still waits for its money.",
        ur: 'یہ ایک آزمائشی ادائیگی تھی: کوئی رقم ادا نہیں ہوئی، اور آرڈر ابھی بھی ادائیگی کا انتظار کر رہا ہے۔',
      };
    case 'unavailable':
      return transfer
        ? {
            en: "Paying online isn't working right now. Try again in a while, or pay by transfer below.",
            ur: 'آن لائن ادائیگی ابھی کام نہیں کر رہی۔ کچھ دیر بعد دوبارہ کوشش کریں، یا نیچے دیے گئے اکاؤنٹ میں ٹرانسفر کریں۔',
          }
        : {
            en: "Paying online isn't working right now. Try again in a while, or ask the shop in your chat.",
            ur: 'آن لائن ادائیگی ابھی کام نہیں کر رہی۔ کچھ دیر بعد دوبارہ کوشش کریں، یا اپنی چیٹ میں دکان سے پوچھیں۔',
          };
  }
}

/** A sentence in English, then in Urdu, right to left, as the pages write them. */
function paragraphs(sentence: { en: HtmlValue; ur: HtmlValue }, className: string): Html {
  return html`<div class="text ${className}">
    <p lang="en">${sentence.en}</p>
    <p lang="ur" dir="rtl">${sentence.ur}</p>
  </div>`;
}

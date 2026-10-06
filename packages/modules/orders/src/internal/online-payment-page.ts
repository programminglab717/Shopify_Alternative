import { html, ltr, say, text, type Html, type HtmlValue, type Words } from '@hatti/documents';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import type { OnlineGateway } from './online-payments.js';

// Paying an order online on the pages customers see (ADR-151, ADR-152): the order's own page and
// checkout's thank-you page say it alike, in English and Urdu.

const PAY_ONLINE: Words = { en: 'Pay online', ur: 'آن لائن ادائیگی کریں' };

/** Why paying online did not go as the customer meant it to. */
export type OnlinePaymentProblem = 'unavailable' | 'pending' | 'test';

/**
 * Pays what the order waits for online, through the shop's gateways (ADR-219): a button for each,
 * posting `action=pay` and the gateway it names to the page, which answers with that gateway's
 * page; through which, and, where `transfer`, a transfer to the account below as the other way.
 * A shop with one gateway shows one button, Pay online, naming its gateway below it.
 */
export function payOnlineForm(
  online: { gateways: readonly OnlineGateway[]; amount: bigint },
  currency: CurrencyCode,
  transfer: boolean,
): Html {
  const due = formatMoney(money(online.amount, currency));
  const names = gatewayNames(online.gateways);
  const one = online.gateways.length === 1;
  return html`<form method="post">
    <input type="hidden" name="action" value="pay" />
    ${online.gateways.map(
      (gateway) =>
        html`<button class="button stack" type="submit" name="gateway" value="${gateway.gateway}">
          ${say('bilingual', one ? PAY_ONLINE : payWith(gateway.name))}
        </button>`,
    )}
    ${paragraphs(
      {
        en:
          `Pay ${due} by card or wallet, through ${names.en}.` +
          (transfer ? ' Or transfer it to the account below.' : ''),
        ur: html`${ltr(due)} کارڈ یا والیٹ سے ${names.ur} کے ذریعے ادا
        کریں۔${transfer && ' یا نیچے دیے گئے اکاؤنٹ میں ٹرانسفر کریں۔'}`,
      },
      'center small muted',
    )}
  </form>`;
}

/**
 * The gateways' names as a sentence lists them, "JazzCash, Easypaisa or Safepay", in English and
 * in Urdu, for pages offering them (ADR-219).
 */
export function gatewayNames(gateways: readonly { name: string }[]): { en: string; ur: Html } {
  const names = gateways.map((gateway) => gateway.name);
  const last = names.at(-1) ?? '';
  const rest = names.slice(0, -1);
  if (rest.length === 0) return { en: last, ur: text(last) };
  return {
    en: `${rest.join(', ')} or ${last}`,
    ur: html`${rest.map((name, index) => html`${index > 0 && '، '}${text(name)}`)} یا ${text(last)}`,
  };
}

/**
 * Of the gateways a page offers, the one the customer chose by `gateway`, as its form posts it;
 * the first when they chose none, as a page from before they could choose posts (ADR-219); null
 * for one it does not offer.
 */
export function chosenGateway(
  offered: readonly OnlineGateway[],
  gateway: string | null | undefined,
): OnlineGateway | null {
  if (!gateway) return offered[0] ?? null;
  return offered.find((each) => each.gateway === gateway) ?? null;
}

/**
 * Where the gateways' pages are, by origin, which a page offering them lets its forms go on to,
 * as browsers hold a form's redirect to the page's policy (ADR-151).
 */
export function gatewayOrigins(gateways: readonly OnlineGateway[]): string[] {
  return [...new Set(gateways.flatMap((gateway) => (gateway.origin ? [gateway.origin] : [])))];
}

/** A button's words for paying through one of the shop's gateways. */
function payWith(name: string): Words {
  return { en: `Pay with ${name}`, ur: `${name} سے ادائیگی کریں` };
}

/** What the customer's browser posts to a gateway whose page takes a form, as JazzCash's does. */
export interface GatewayFormStart {
  url: string;
  form: Readonly<Record<string, string>>;
  /** The gateway's name, as pages say it, such as "JazzCash (test)". */
  gateway: string;
}

/**
 * On to the shop's gateway whose page takes a form (ADR-163): the payment's signed fields,
 * hidden, and a button that posts them there, since these pages run no scripts; `due` is what the
 * customer pays, as the page says it.
 */
export function gatewayForm(started: GatewayFormStart, due: string): Html {
  const { gateway } = started;
  return html`<form method="post" action="${started.url}">
    ${Object.entries(started.form).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    <button class="button stack" type="submit">
      ${say('bilingual', { en: `Continue to ${gateway}`, ur: `${gateway} پر جاری رکھیں` })}
    </button>
    ${paragraphs(
      {
        en: `Pay ${due} on ${gateway}'s page, by card, wallet or voucher.`,
        ur: html`${ltr(due)} ${text(gateway)} کے صفحے پر کارڈ، والیٹ یا واؤچر سے ادا کریں۔`,
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

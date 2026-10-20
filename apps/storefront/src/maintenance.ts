import {
  html,
  ltr,
  renderPage,
  say,
  type Html,
  type RenderedPage,
  type Words,
} from '@hatti/documents';
import type { MaintenanceDoc, ShopDoc } from '@hatti/storefront-data';
import { escapeHtml } from './liquid.js';

/**
 * How long a paused shop asks search engines and shoppers' apps to wait before asking again
 * (ADR-252): until it opens, if it said when, but never more than a day, so that crawlers keep
 * its pages; an hour while it did not say.
 */
export const RETRY_AFTER = { unknown: 3_600, min: 60, max: 86_400 } as const;

const WORDS = {
  title: { en: 'This shop is taking a short break', ur: 'یہ دکان کچھ دیر کے لیے بند ہے' },
  askOnWhatsapp: { en: 'Message the shop on WhatsApp', ur: 'دکان کو واٹس ایپ پر پیغام بھیجیں' },
  track: { en: 'Track your order', ur: 'اپنا آرڈر ٹریک کریں' },
  opensSoon: { en: 'This store opens soon', ur: 'یہ دکان جلد کھلے گی' },
  beingBuilt: {
    en: 'It is being built. Come back to shop here once it opens.',
    ur: 'یہ ابھی بن رہی ہے۔ کھلنے پر یہاں خریداری کے لیے دوبارہ آئیں۔',
  },
} satisfies Record<string, Words>;

/** The seconds a paused shop's answers ask to wait, for their Retry-After header. */
export function retryAfterOf(maintenance: MaintenanceDoc, now: Date): number {
  if (maintenance.until === null) return RETRY_AFTER.unknown;
  const seconds = Math.ceil((Date.parse(maintenance.until) - now.getTime()) / 1000);
  return Math.min(Math.max(seconds, RETRY_AFTER.min), RETRY_AFTER.max);
}

/**
 * The page a paused shop shows shoppers in place of its own (ADR-252): its logo or name, what it
 * typed for them, when it takes orders again, and where to ask it or follow an order placed
 * before. In English and Urdu, as the platform's other pages for customers are, and in the
 * platform's markup, since a theme has no template for it.
 */
export function maintenancePage(
  shop: ShopDoc,
  maintenance: MaintenanceDoc,
  options: { urdu: boolean },
): RenderedPage {
  const logo = shop.brand?.logo ?? null;
  const when =
    maintenance.until && momentOf(new Date(maintenance.until), shop.timezone ?? 'Asia/Karachi');
  return renderPage({
    title: `${WORDS.title.en} · ${shop.name}`,
    images: logo ? [logo] : [],
    body: html`
      ${
        logo
          ? html`<p class="shop"><img class="logo" src="${logo}" alt="${shop.name}" /></p>`
          : html`<p class="shop"><bdi>${shop.name}</bdi></p>`
      }
      <h1 class="title stack">${say('bilingual', WORDS.title)}</h1>
      ${maintenance.message && typedParagraphs(maintenance.message)}
      <div class="text center muted">
        ${
          when
            ? html`<p lang="en">It takes orders again from ${when}.</p>
                <p lang="ur" dir="rtl">یہ دکان ${ltr(when)} سے دوبارہ آرڈر لے گی۔</p>`
            : html`<p lang="en">It takes orders again soon.</p>
                <p lang="ur" dir="rtl">یہ دکان جلد دوبارہ آرڈر لینا شروع کرے گی۔</p>`
        }
      </div>
      ${
        shop.whatsapp &&
        html`<p class="center">
          <a href="https://wa.me/${shop.whatsapp.slice(1)}" target="_blank" rel="noopener"
            >${say('bilingual', WORDS.askOnWhatsapp)}</a
          >
        </p>`
      }
      <p class="center">
        <a href="${options.urdu ? '/ur/track' : '/track'}">${say('bilingual', WORDS.track)}</a>
      </p>
    `,
  });
}

/**
 * The page a partner's development store shows shoppers while it is built (PRT-01, ADR-504): its
 * logo or name, and that it opens soon. Nothing of its own runs; its staff's previews show it.
 */
export function developmentPage(shop: ShopDoc): RenderedPage {
  const logo = shop.brand?.logo ?? null;
  return renderPage({
    title: `${WORDS.opensSoon.en} · ${shop.name}`,
    images: logo ? [logo] : [],
    body: html`
      ${
        logo
          ? html`<p class="shop"><img class="logo" src="${logo}" alt="${shop.name}" /></p>`
          : html`<p class="shop"><bdi>${shop.name}</bdi></p>`
      }
      <h1 class="title stack">${say('bilingual', WORDS.opensSoon)}</h1>
      <div class="text center muted">${say('bilingual', WORDS.beingBuilt)}</div>
    `,
  });
}

/** The bar's words while checkout alone is paused (ADR-604), in each of the platform's languages. */
const BAR_WORDS: Readonly<Record<'en' | 'ur', { title: string; from: string; soon: string }>> = {
  en: {
    title: 'Orders are paused for a while.',
    from: 'We take orders again from {when}.',
    soon: 'We take orders again soon.',
  },
  ur: {
    title: 'آرڈر کچھ دیر کے لیے بند ہیں۔',
    from: 'ہم {when} سے دوبارہ آرڈر لیں گے۔',
    soon: 'ہم جلد دوبارہ آرڈر لیں گے۔',
  },
};

/**
 * The bar the open storefront's pages show while checkout alone is paused (ADR-604): that orders
 * are paused, the shop's message on one line, and when they come back, in the page's language. It
 * is laid over the theme's page at its top by a script, as the preview bar is, and goes away by
 * itself once the time the shop set has come, for pages kept in a cache. A theme that says so
 * itself, from `shop.checkout_paused`, marks its notice `data-checkout-paused` (ADR-620): the
 * bar stands aside for it, and takes it away with the bar's own time, turning on again what the
 * theme turned off while it lasted, marked `data-checkout-paused-disabled` (ADR-622).
 */
export function checkoutPausedBar(
  shop: ShopDoc,
  maintenance: MaintenanceDoc,
  locale: string,
): string {
  const words = BAR_WORDS[locale === 'ur' ? 'ur' : 'en'];
  const when =
    maintenance.until && momentOf(new Date(maintenance.until), shop.timezone ?? 'Asia/Karachi');
  const message = maintenance.message.replace(/\s+/g, ' ').trim();
  const until = maintenance.until ? Date.parse(maintenance.until) : null;
  return (
    '<template id="hatti-paused-bar">' +
    `<div class="hatti-paused-bar" role="status" dir="${locale === 'ur' ? 'rtl' : 'ltr'}">` +
    `<strong>${escapeHtml(words.title)}</strong>` +
    (message ? ` <span dir="auto">${escapeHtml(message)}</span>` : '') +
    ` <span>${escapeHtml(when ? words.from.replace('{when}', when) : words.soon)}</span>` +
    '</div></template>' +
    '<style>.hatti-paused-bar{position:sticky;top:0;z-index:2147483646;padding:.625rem 1rem;' +
    'background:#fef3c7;color:#78350f;font:14px/1.5 system-ui,sans-serif;text-align:center}' +
    '</style>' +
    '<script>addEventListener("DOMContentLoaded",function(){' +
    (until !== null
      ? `if(Date.now()>=${until}){document.querySelectorAll("[data-checkout-paused]")` +
        '.forEach(function(own){own.remove()});' +
        'document.querySelectorAll("[data-checkout-paused-disabled]")' +
        '.forEach(function(off){off.disabled=false});return}'
      : '') +
    'if(document.querySelector("[data-checkout-paused]"))return;' +
    'var bar=document.getElementById("hatti-paused-bar");if(bar)document.body.prepend(bar.content)' +
    '})</script>'
  );
}

/** What the shop typed, as it wrote it: its paragraphs apart, its lines broken where it broke them. */
function typedParagraphs(typed: string): Html {
  const written = typed
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return html`<div class="text">
    ${written.map(
      (paragraph) =>
        html`<p dir="auto">
          ${paragraph.split('\n').map((line, index) => [index > 0 && html`<br />`, line])}
        </p>`,
    )}
  </div>`;
}

/** "12 October 2026 at 9:00 am", in the shop's time zone. */
function momentOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

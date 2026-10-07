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

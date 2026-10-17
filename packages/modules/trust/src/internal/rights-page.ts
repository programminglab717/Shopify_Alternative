import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import {
  RIGHTS_LIMITS,
  type RightsCounterProblem,
  type RightsCounterStatus,
  type RightsKind,
  type RightsView,
} from './rights.service.js';

// A rights link's page (ADR-476): the store's owner sees the complaint that took their listings
// down, and answers it with a sworn counter-notice, once. Theirs alone, by the link's secret, in
// English and Urdu, as Hatti's other pages for people who may read either.

const WORDS = {
  title: {
    en: 'Listings taken down after a rights complaint',
    ur: 'حقوق کی شکایت پر اشیاء کی فروخت روک دی گئی',
  },
  released: { en: 'Your listings are let go', ur: 'آپ کی اشیاء بحال کر دی گئی ہیں' },
  complaint: { en: 'The complaint', ur: 'شکایت' },
  listings: { en: 'The listings', ur: 'اشیاء' },
  decision: { en: "Hatti's decision", ur: 'ہٹی کا فیصلہ' },
  reach: { en: 'Who complained', ur: 'شکایت کس نے کی' },
  yours: { en: 'Your answer', ur: 'آپ کا جواب' },
  sworn: {
    en: "I believe in good faith that these listings were taken down by mistake, or that I have the right to sell them. I run this store, and what I say here is true. Hatti may give my answer and my store's name to the complainant.",
    ur: 'میں نیک نیتی سے سمجھتا/سمجھتی ہوں کہ یہ اشیاء غلطی سے ہٹائی گئیں، یا مجھے انہیں بیچنے کا حق ہے۔ یہ دکان میں چلاتا/چلاتی ہوں، اور جو میں نے یہاں لکھا ہے وہ سچ ہے۔ ہٹی میرا جواب اور میری دکان کا نام شکایت کنندہ کو دے سکتا ہے۔',
  },
  signature: { en: 'Type your full name to sign', ur: 'دستخط کے لیے اپنا پورا نام لکھیں' },
  send: { en: 'Send the answer', ur: 'جواب بھیجیں' },
  sent: {
    en: 'Hatti has your answer: its decision comes within 48 hours, here and on WhatsApp.',
    ur: 'ہٹی کو آپ کا جواب مل گیا ہے: اس کا فیصلہ 48 گھنٹوں میں یہاں اور واٹس ایپ پر آئے گا۔',
  },
  hattiSaid: { en: "Hatti's answer", ur: 'ہٹی کا جواب' },
  letGo: {
    en: 'Hatti has let them go. Put them on sale again from your admin.',
    ur: 'ہٹی نے انہیں بحال کر دیا ہے۔ اپنے ایڈمن سے انہیں دوبارہ فروخت پر لگائیں۔',
  },
  notFound: { en: "This link isn't known", ur: 'یہ لنک معلوم نہیں' },
} satisfies Record<string, Words>;

const KINDS: Record<RightsKind, Words> = {
  trademark: { en: 'Trademark', ur: 'ٹریڈ مارک' },
  copyright: { en: 'Copyright', ur: 'کاپی رائٹ' },
  counterfeit: { en: 'Fake goods sold as the brand', ur: 'برانڈ کے نام پر نقلی سامان' },
};

const STATUS: Record<RightsCounterStatus, Words> = {
  open: { en: 'Waiting for Hatti', ur: 'ہٹی کے فیصلے کا انتظار' },
  refused: { en: 'Refused', ur: 'مسترد' },
  upheld: { en: 'Upheld: the listings are let go', ur: 'منظور: اشیاء بحال کر دی گئیں' },
};

const PROBLEMS: Record<RightsCounterProblem, Words> = {
  blank: { en: 'Write your answer.', ur: 'اپنا جواب لکھیں۔' },
  too_long: {
    en: `Write it in ${RIGHTS_LIMITS.counter.toLocaleString('en')} letters at most.`,
    ur: `زیادہ سے زیادہ ${RIGHTS_LIMITS.counter.toLocaleString('en')} حروف میں لکھیں۔`,
  },
  unsworn: {
    en: 'Tick the statement to send your answer.',
    ur: 'جواب بھیجنے کے لیے بیان پر نشان لگائیں۔',
  },
  unsigned: { en: 'Type your full name to sign.', ur: 'دستخط کے لیے اپنا پورا نام لکھیں۔' },
  countered: {
    en: 'You have answered this complaint already.',
    ur: 'آپ اس شکایت کا جواب پہلے ہی دے چکے ہیں۔',
  },
  released: { en: 'Your listings are let go already.', ur: 'آپ کی اشیاء پہلے ہی بحال ہو چکی ہیں۔' },
};

/** What the owner typed, shown again where something was wrong. */
export interface RightsTyped {
  words: string;
  signature: string;
  sworn: boolean;
}

/** A rights link's page; or that the link isn't known, with 404. */
export function rightsPage(
  view: RightsView | null,
  options: { sent?: boolean; problem?: RightsCounterProblem; typed?: RightsTyped } = {},
): RenderedPage & { status: number } {
  if (!view) {
    const page = renderPage({
      title: WORDS.notFound.en,
      body: html`<h1 class="title stack">${say('bilingual', WORDS.notFound)}</h1>`,
    });
    return { status: 404, ...page };
  }
  const heading = view.releasedAt ? WORDS.released : WORDS.title;
  const page = renderPage({
    title: `${heading.en} · ${view.shopName}`,
    body: html`
      <p class="shop"><bdi>${view.shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', heading)}</h1>
      ${options.sent && html`<div class="banner done stack" role="status">${both(WORDS.sent)}</div>`}
      <div class="section">
        <p class="label">${say('bilingual', WORDS.complaint)}</p>
        <p>
          ${KINDS[view.kind].en} · ${KINDS[view.kind].ur}: <bdi>${view.rightsOwner}</bdi>${
            view.registration && html` (<bdi>${view.registration}</bdi>)`
          }
        </p>
        <p dir="auto">${view.details}</p>
      </div>
      <div class="section">
        <p class="label">${say('bilingual', WORDS.listings)}</p>
        <ul>
          ${view.listings.map(
            (listing) =>
              html`<li><bdi>${listing.title}</bdi> <span dir="ltr">${listing.url}</span></li>`,
          )}
        </ul>
      </div>
      <div class="section">
        <p class="label">${say('bilingual', WORDS.reach)}</p>
        <p><bdi>${view.complainant}</bdi> · <span dir="ltr">${view.email}</span></p>
      </div>
      <div class="section">
        <p class="label">${say('bilingual', WORDS.decision)}</p>
        <p dir="auto">${view.decision}</p>
      </div>
      ${view.counter && counterEntry(view.counter)}
      ${
        view.releasedAt &&
        html`<div class="section">
          ${both(WORDS.letGo)} ${view.releaseNote && html`<p dir="auto">${view.releaseNote}</p>`}
        </div>`
      }
      ${view.canCounter && form(options.problem, options.typed)}
      ${!view.canCounter && options.problem && html`<div role="alert">${errorOf(options.problem)}</div>`}
    `,
  });
  return { status: options.problem ? 422 : 200, ...page };
}

function counterEntry(counter: NonNullable<RightsView['counter']>): Html {
  return html`<div class="section">
    <p class="label">${say('bilingual', STATUS[counter.status])}</p>
    <p dir="auto">${counter.words}</p>
    ${
      counter.answer &&
      html`<p class="label">${say('bilingual', WORDS.hattiSaid)}</p>
        <p dir="auto">${counter.answer}</p>`
    }
  </div>`;
}

function form(problem: RightsCounterProblem | undefined, typed: RightsTyped | undefined): Html {
  const field = (name: string): boolean =>
    (name === 'words' && (problem === 'blank' || problem === 'too_long')) ||
    (name === 'sworn' && problem === 'unsworn') ||
    (name === 'signature' && problem === 'unsigned');
  return html`<form method="post">
    <div class="field">
      <label class="label" for="words">${say('bilingual', WORDS.yours)}</label>
      <textarea
        id="words"
        name="words"
        dir="auto"
        maxlength="${RIGHTS_LIMITS.counter}"
        aria-required="true"
        ${field('words') && html`aria-invalid="true" aria-describedby="words-error"`}
      >
${typed?.words ?? ''}</textarea>
      ${field('words') && html`<div id="words-error">${errorOf(problem!)}</div>`}
    </div>
    <div class="field">
      <label class="choice">
        <input
          type="checkbox"
          name="sworn"
          value="1"
          ${typed?.sworn && html`checked`}
          ${field('sworn') && html`aria-invalid="true" aria-describedby="sworn-error"`}
        />
        <span
          ><span lang="en">${WORDS.sworn.en}</span
          ><span lang="ur" dir="rtl">${WORDS.sworn.ur}</span></span
        >
      </label>
      ${field('sworn') && html`<div id="sworn-error">${errorOf(problem!)}</div>`}
    </div>
    <div class="field">
      <label class="label" for="signature">${say('bilingual', WORDS.signature)}</label>
      <input
        id="signature"
        name="signature"
        type="text"
        dir="auto"
        autocomplete="name"
        value="${typed?.signature ?? ''}"
        ${field('signature') && html`aria-invalid="true" aria-describedby="signature-error"`}
      />
      ${field('signature') && html`<div id="signature-error">${errorOf(problem!)}</div>`}
    </div>
    <button class="button" type="submit">${say('bilingual', WORDS.send)}</button>
  </form>`;
}

function errorOf(problem: RightsCounterProblem): Html {
  const words = PROBLEMS[problem];
  return html`<p class="error" lang="en">${words.en}</p>
    <p class="error" lang="ur" dir="rtl">${words.ur}</p>`;
}

function both(words: Words): Html {
  return html`<p lang="en">${words.en}</p>
    <p lang="ur" dir="rtl">${words.ur}</p>`;
}

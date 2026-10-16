import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import {
  APPEAL_LIMITS,
  type AppealEntry,
  type AppealProblem,
  type AppealView,
} from './appeals.service.js';

// An appeal link's page (ADR-462): the store's owner can't sign in while it is down, so this page
// is theirs alone, by the link's secret. In English and Urdu, as Hatti's other pages for people
// who may read either.

const WORDS = {
  title: { en: 'Your store is taken down', ur: 'آپ کی دکان بند کر دی گئی ہے' },
  restored: { en: 'Your store is open again', ur: 'آپ کی دکان دوبارہ کھل گئی ہے' },
  why: { en: 'Why', ur: 'وجہ' },
  yours: { en: 'Your side of it', ur: 'آپ کا مؤقف' },
  send: { en: 'Send the appeal', ur: 'اپیل بھیجیں' },
  sent: {
    en: 'Hatti has your appeal: its answer comes within 48 hours, here and on WhatsApp.',
    ur: 'ہٹی کو آپ کی اپیل مل گئی ہے: اس کا جواب 48 گھنٹوں میں یہاں اور واٹس ایپ پر آئے گا۔',
  },
  waiting: { en: 'Waiting for Hatti', ur: 'ہٹی کے جواب کا انتظار' },
  refused: { en: 'Refused', ur: 'مسترد' },
  upheld: { en: 'Upheld: the store is open again', ur: 'منظور: دکان دوبارہ کھل گئی' },
  hattiSaid: { en: "Hatti's answer", ur: 'ہٹی کا جواب' },
  notFound: { en: "This link isn't known", ur: 'یہ لنک معلوم نہیں' },
} satisfies Record<string, Words>;

const PROBLEMS: Record<AppealProblem, Words> = {
  blank: { en: 'Write your side of it.', ur: 'اپنا مؤقف لکھیں۔' },
  too_long: {
    en: `Write it in ${APPEAL_LIMITS.words.toLocaleString('en')} letters at most.`,
    ur: `زیادہ سے زیادہ ${APPEAL_LIMITS.words.toLocaleString('en')} حروف میں لکھیں۔`,
  },
  restored: { en: 'Your store is open again.', ur: 'آپ کی دکان دوبارہ کھل گئی ہے۔' },
  waiting: {
    en: 'Your appeal is waiting for Hatti: send another once it is answered.',
    ur: 'آپ کی اپیل ہٹی کے جواب کی منتظر ہے: جواب آنے کے بعد دوسری بھیجیں۔',
  },
  too_many: {
    en: `A store can be appealed ${APPEAL_LIMITS.perTakedown} times.`,
    ur: `ایک دکان کی ${APPEAL_LIMITS.perTakedown} بار اپیل کی جا سکتی ہے۔`,
  },
};

const STATUS: Record<AppealEntry['status'], Words> = {
  open: WORDS.waiting,
  refused: WORDS.refused,
  upheld: WORDS.upheld,
};

/** An appeal link's page; or that the link isn't known, with 404. */
export function appealPage(
  view: AppealView | null,
  options: { sent?: boolean; problem?: AppealProblem; typed?: string } = {},
): RenderedPage & { status: number } {
  if (!view) {
    const page = renderPage({
      title: WORDS.notFound.en,
      body: html`<h1 class="title stack">${say('bilingual', WORDS.notFound)}</h1>`,
    });
    return { status: 404, ...page };
  }
  const heading = view.restoredAt ? WORDS.restored : WORDS.title;
  const page = renderPage({
    title: `${heading.en} · ${view.shopName}`,
    body: html`
      <p class="shop"><bdi>${view.shopName}</bdi></p>
      <h1 class="title stack">${say('bilingual', heading)}</h1>
      ${options.sent && html`<div class="banner done stack" role="status">${both(WORDS.sent)}</div>`}
      <div class="section">
        <p class="label">${say('bilingual', WORDS.why)}</p>
        <p dir="auto">${view.note}</p>
      </div>
      ${view.appeals.map(entry)} ${view.canAppeal && form(options.problem, options.typed ?? '')}
      ${!view.canAppeal && options.problem && html`<div role="alert">${errorOf(options.problem)}</div>`}
    `,
  });
  return { status: options.problem ? 422 : 200, ...page };
}

function entry(appeal: AppealEntry): Html {
  return html`<div class="section">
    <p class="label">${say('bilingual', STATUS[appeal.status])}</p>
    <p dir="auto">${appeal.words}</p>
    ${
      appeal.answer &&
      html`<p class="label">${say('bilingual', WORDS.hattiSaid)}</p>
        <p dir="auto">${appeal.answer}</p>`
    }
  </div>`;
}

function form(problem: AppealProblem | undefined, typed: string): Html {
  const wrong = problem === 'blank' || problem === 'too_long';
  return html`<form method="post">
    <div class="field">
      <label class="label" for="words">${say('bilingual', WORDS.yours)}</label>
      <textarea
        id="words"
        name="words"
        dir="auto"
        maxlength="${APPEAL_LIMITS.words}"
        aria-required="true"
        ${wrong && html`aria-invalid="true" aria-describedby="words-error"`}
      >
${typed}</textarea>
      ${problem && html`<div id="words-error">${errorOf(problem)}</div>`}
    </div>
    <button class="button" type="submit">${say('bilingual', WORDS.send)}</button>
  </form>`;
}

function errorOf(problem: AppealProblem): Html {
  const words = PROBLEMS[problem];
  return html`<p class="error" lang="en">${words.en}</p>
    <p class="error" lang="ur" dir="rtl">${words.ur}</p>`;
}

function both(words: Words): Html {
  return html`<p lang="en">${words.en}</p>
    <p lang="ur" dir="rtl">${words.ur}</p>`;
}

import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import { LEGAL_DOCUMENTS, LEGAL_REVIEWED, SUB_PROCESSORS, type LegalDocument } from '@hatti/legal';

// Hatti's own legal documents on its own pages (ADR-736): /legal lists them, /legal/{handle}
// shows one, its English text that binds under its gist in Urdu. Until counsel has reviewed them
// (OWN-41), each says it is a draft.

const WORDS = {
  title: { en: "Hatti's legal documents", ur: 'ہٹی کی قانونی دستاویزات' },
  draft: {
    en: 'A draft, still to be reviewed by counsel: it may change before Hatti opens, and words in [brackets] are still to come.',
    ur: 'یہ مسودہ ہے، جس کا ابھی وکیل جائزہ لیں گے: ہٹی کے کھلنے سے پہلے یہ بدل سکتا ہے، اور [بریکٹ] میں لکھی باتیں ابھی آنی ہیں۔',
  },
  version: { en: 'In effect from', ur: 'نافذ از' },
  gist: { en: 'In Urdu, in short', ur: 'اردو میں خلاصہ' },
  binds: {
    en: 'The English text below is what binds.',
    ur: 'نیچے دیا گیا انگریزی متن ہی قابلِ عمل ہے۔',
  },
  list: { en: 'The services', ur: 'سروسز' },
  purpose: { en: 'What for', ur: 'کس لیے' },
  data: { en: 'Data it gets', ur: 'کون سا ڈیٹا' },
  location: { en: 'Where', ur: 'کہاں' },
  toChoose: { en: 'Still to be chosen', ur: 'ابھی منتخب ہونا ہے' },
  all: { en: 'All legal documents', ur: 'تمام قانونی دستاویزات' },
  notFound: {
    en: "There's no such document: these are Hatti's.",
    ur: 'ایسی کوئی دستاویز نہیں: ہٹی کی دستاویزات یہ ہیں۔',
  },
} satisfies Record<string, Words>;

/** The list of Hatti's legal documents, or it with `missing` said first. */
export function legalIndexPage(missing = false): RenderedPage {
  return renderPage({
    title: WORDS.title.en,
    body: html`
      <h1 class="title stack">${say('bilingual', WORDS.title)}</h1>
      ${missing && html`<div class="banner stack" role="status">${both(WORDS.notFound)}</div>`}
      ${draftBanner()}
      ${LEGAL_DOCUMENTS.map(
        (document) =>
          html`<div class="section" data-document="${document.handle}">
            <p class="stack">
              <a href="/legal/${document.handle}">${say('bilingual', document.title)}</a>
            </p>
            <p class="small muted">${document.summary}</p>
            <p class="small muted">${WORDS.version.en} ${dateWords(document.version)}</p>
          </div>`,
      )}
    `,
  });
}

/** One of Hatti's legal documents. */
export function legalPage(document: LegalDocument): RenderedPage {
  return renderPage({
    title: `${document.title.en} · Hatti`,
    body: html`
      <h1 class="title stack">${say('bilingual', document.title)}</h1>
      ${draftBanner()}
      <p class="small muted center">
        ${WORDS.version.en} ${dateWords(document.version)} ·
        <span lang="ur" dir="rtl"
          >${WORDS.version.ur} <bdi dir="ltr">${document.version}</bdi></span
        >
      </p>
      <div class="section" lang="ur" dir="rtl">
        <p class="label">${WORDS.gist.ur}</p>
        ${document.urdu.map((paragraph) => html`<p>${paragraph}</p>`)}
        <p class="small muted">${WORDS.binds.ur}</p>
      </div>
      ${document.sections.map(
        (section) =>
          html`<div class="section">
            <h2 class="label">${section.heading}</h2>
            ${section.paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
          </div>`,
      )}
      ${document.handle === 'sub-processors' && subProcessorList()}
      <div class="section small">
        <a href="/legal">${say('bilingual', WORDS.all)}</a>
      </div>
    `,
  });
}

/** What the platform's own pages and its admin read: each document's version and address. */
export function legalJson(): object {
  return {
    reviewed: LEGAL_REVIEWED,
    documents: LEGAL_DOCUMENTS.map((document) => ({
      handle: document.handle,
      title: document.title.en,
      titleUr: document.title.ur,
      version: document.version,
      path: `/legal/${document.handle}`,
    })),
  };
}

function subProcessorList(): Html {
  return html`<div class="section">
    <p class="label">${say('bilingual', WORDS.list)}</p>
    ${SUB_PROCESSORS.map(
      (each) =>
        html`<div class="section" data-status="${each.status}">
          <p class="strong">${each.name}</p>
          ${each.status === 'to_choose' && html`<p class="small muted">${say('bilingual', WORDS.toChoose)}</p>`}
          <p class="small"><span class="muted">${WORDS.purpose.en}:</span> ${each.purpose}</p>
          <p class="small"><span class="muted">${WORDS.data.en}:</span> ${each.data}</p>
          <p class="small"><span class="muted">${WORDS.location.en}:</span> ${each.location}</p>
        </div>`,
    )}
  </div>`;
}

function draftBanner(): Html {
  return LEGAL_REVIEWED
    ? html``
    : html`<div class="banner stack" role="note">${both(WORDS.draft)}</div>`;
}

/** "22 October 2026", from YYYY-MM-DD. */
function dateWords(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));
}

function both(words: Words): Html {
  return html`<p lang="en">${words.en}</p>
    <p lang="ur" dir="rtl">${words.ur}</p>`;
}

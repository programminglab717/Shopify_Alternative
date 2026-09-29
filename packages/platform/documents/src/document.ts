import { html, toMarkup, trusted, type Html } from './html.js';

/**
 * Paper a document is set up for: A4 sheets, 4×6 inch thermal labels, or an 80 mm thermal
 * receipt roll.
 */
export const PAPERS = ['a4', 'thermal_4x6', 'thermal_80mm'] as const;
export type Paper = (typeof PAPERS)[number];

/** English, Urdu (right to left), or both, English first. */
export const LANGUAGES = ['bilingual', 'english', 'urdu'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Wording in English and Urdu, for documents in either language or both. */
export interface Words {
  en: string;
  ur: string;
}

/** `words` in the document's language. In both, the Urdu follows the English. */
export function say(language: Language, words: Words): Html {
  if (language === 'english') return html`${words.en}`;
  if (language === 'urdu') return html`<span lang="ur">${words.ur}</span>`;
  const en = html`<span lang="en">${words.en}</span>`;
  const ur = html`<span lang="ur" dir="rtl">${words.ur}</span>`;
  return html`<span class="both">${en} ${ur}</span>`;
}

/**
 * Text that people typed, such as a name or an address line, which runs in whichever direction
 * its script does. Nothing for null.
 */
export function text(value: string | null | undefined): Html {
  return value ? html`<bdi>${value}</bdi>` : html``;
}

/** Numbers, amounts and codes, which read left to right in an Urdu document too: "#1001". */
export function ltr(value: string): Html {
  return html`<bdi dir="ltr">${value}</bdi>`;
}

export interface DocumentOptions {
  /** For the browser tab and a saved file, such as "Packing slip #1001". */
  title: string;
  paper: Paper;
  language: Language;
  /** Each starts a new page; on a thermal roll, the printer cuts between them. */
  pages: readonly Html[];
}

// The families of @hatti/tokens. Pages are set in Inter, and Urdu letters that people typed,
// which Inter lacks, fall through to Nastaliq. Urdu wording is set in Nastaliq, larger and with
// room for its tall letters, in its own spans, so that lines without it stay compact.
const TEXT_FONTS = 'Inter, "Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", system-ui, sans-serif';
const URDU_FONTS = '"Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", Inter, serif';
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700' +
  '&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap';

// Class names templates use: header, shop, title, meta, columns, label, box, banner, lines,
// totals (with a grand row), num, strong, big, muted, small, stack (Urdu under English) and
// footer.
const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html {
  color: #111827;
  background: #fff;
  font-family: ${TEXT_FONTS};
  line-height: 1.45;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body { margin: 0; }
h1, h2, p { margin: 0; font-size: inherit; }
span[lang="ur"] { font-family: ${URDU_FONTS}; font-size: 1.1em; line-height: 2; }
.both > [lang="ur"] { margin-inline-start: 0.5em; }
/* Only bilingual documents stack, and they run left to right: an Urdu block would take its own
   start and end from right to left, so it is aligned with its column here. */
.stack .both > [lang="ur"] { display: block; margin-inline-start: 0; text-align: left; }
.stack.num .both > [lang="ur"] { text-align: right; }
.page { break-after: page; }
.page:last-child { break-after: auto; }
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1em;
  padding-bottom: 0.6em;
  margin-bottom: 0.8em;
  border-bottom: 2px solid #111827;
}
.shop { font-size: 1.4em; font-weight: 700; }
.title { font-size: 1.2em; font-weight: 700; }
.meta { text-align: end; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1em; margin-bottom: 0.9em; }
.label { color: #374151; font-size: 0.8em; font-weight: 600; }
.box { padding: 0.5em 0.7em; border: 1.5px solid #111827; border-radius: 4px; }
.banner {
  padding: 0.4em 0.6em;
  margin-bottom: 0.8em;
  border: 2px solid #111827;
  background: #e5e7eb;
  font-weight: 700;
  text-align: center;
}
table { width: 100%; border-collapse: collapse; }
.lines { margin-bottom: 0.8em; }
.lines th {
  padding: 0.3em 0.4em;
  border-bottom: 1.5px solid #111827;
  font-size: 0.8em;
  text-align: start;
  vertical-align: bottom;
}
.lines td { padding: 0.35em 0.4em; border-bottom: 1px solid #d1d5db; vertical-align: top; }
.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
.lines th.num { text-align: end; }
.totals { width: 55%; margin-inline-start: auto; }
.totals td { padding: 0.2em 0.4em; }
.totals .grand td { border-top: 1.5px solid #111827; font-weight: 700; }
.strong { font-weight: 700; }
.big { font-size: 1.3em; font-weight: 700; }
.muted { color: #4b5563; }
.small { font-size: 0.85em; }
.footer { margin-top: 1.2em; text-align: center; }
@media screen {
  html { background: #e5e7eb; }
  .page { margin: 24px auto; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15); }
}
`;

// Thermal paper is narrow: one column, headings centred.
const NARROW = `
.header { display: block; text-align: center; }
.meta { text-align: center; }
.columns { grid-template-columns: 1fr; gap: 0.6em; }
.totals { width: 100%; }
`;

const PAPER_STYLES: Readonly<Record<Paper, string>> = {
  a4: `
@page { size: A4; margin: 14mm 12mm; }
html { font-size: 10pt; }
@media screen { .page { width: 210mm; min-height: 297mm; padding: 14mm 12mm; } }
`,
  thermal_4x6: `
@page { size: 4in 6in; margin: 4mm; }
html { font-size: 8pt; }
${NARROW}
@media screen { .page { width: 4in; min-height: 6in; padding: 4mm; } }
`,
  // A roll has no fixed length: the printer's paper setting decides it. The printable width of
  // 80 mm paper is 72 mm.
  thermal_80mm: `
@page { margin: 0; }
html { font-size: 8.5pt; }
${NARROW}
.page { width: 72mm; margin-inline: auto; padding: 3mm 0; }
@media screen { .page { width: 80mm; padding: 3mm 4mm; } }
`,
};

/**
 * A complete HTML page of `pages`, ready for the browser's print dialog or a PDF renderer. It
 * loads Inter and Noto Nastaliq Urdu from Google Fonts; wait for `document.fonts.ready` before
 * printing. It runs no scripts.
 */
export function renderDocument(options: DocumentOptions): string {
  const urdu = options.language === 'urdu';
  return toMarkup(
    html`<!doctype html>
      <html
        lang="${urdu ? 'ur' : 'en'}"
        dir="${urdu ? 'rtl' : 'ltr'}"
        data-paper="${options.paper}"
      >
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${options.title}</title>
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
          <link rel="stylesheet" href="${FONTS_URL}" />
          <style>
            ${trusted(STYLES + PAPER_STYLES[options.paper])}
          </style>
        </head>
        <body>
          ${options.pages.map((page) => html`<article class="page">${page}</article> `)}
        </body>
      </html> `,
  );
}

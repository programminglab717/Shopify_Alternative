import { createHash } from 'node:crypto';
import { FONTS_URL, TEXT_FONTS, URDU_FONTS } from './fonts.js';
import { html, toMarkup, trusted, type Html } from './html.js';

export interface PageOptions {
  /** For the browser tab, such as "Confirm your order · Zari". Never personal data. */
  title: string;
  body: Html;
}

/** A page and the Content-Security-Policy header to send with it. */
export interface RenderedPage {
  html: string;
  contentSecurityPolicy: string;
}

// Colours of @hatti/tokens' light and dark themes. Class names bodies use: shop, title, stack
// (Urdu under English), section, label, text (a block of paragraphs), num, total, due, banner
// (with done), mark, button (with danger), center, muted, small and strong. Urdu paragraphs are
// <p lang="ur" dir="rtl">.
const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html {
  color: #0F172A;
  background: #F8FAFC;
  font-family: ${TEXT_FONTS};
  font-size: 16px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
body { margin: 0; padding: 16px 12px; }
h1, h2, p { margin: 0; font-size: inherit; }
[lang="ur"] { font-family: ${URDU_FONTS}; line-height: 2.1; }
/* Numbers, amounts and dates in Urdu sentences, in their own left-to-right runs. */
[lang="ur"] bdi[dir="ltr"] { font-family: ${TEXT_FONTS}; }
/* An Urdu label beside its English stays in one piece; stacked under it, it wraps. */
.both > [lang="ur"] { margin-inline-start: 0.5em; white-space: nowrap; }
.stack .both > [lang="ur"] { display: block; margin-inline-start: 0; white-space: normal; }
main {
  max-width: 480px;
  margin: 0 auto;
  padding: 20px 16px;
  background: #FFFFFF;
  border: 1px solid #CBD5E1;
  border-radius: 12px;
}
.shop { color: #475569; font-size: 0.9em; font-weight: 600; text-align: center; }
.title { margin: 4px 0 16px; font-size: 1.3em; font-weight: 700; text-align: center; }
.section { padding: 12px 0; border-top: 1px solid #CBD5E1; }
.label { margin-bottom: 4px; color: #475569; font-size: 0.85em; font-weight: 600; }
p + p { margin-top: 6px; }
.text + .text { margin-top: 12px; }
p[dir="rtl"] { text-align: right; }
.center, .center p[dir="rtl"] { text-align: center; }
table { width: 100%; border-collapse: collapse; }
td { padding: 4px 0; vertical-align: baseline; }
.num { padding-inline-start: 12px; text-align: end; white-space: nowrap; }
.total td { padding-top: 8px; font-weight: 700; }
.due td { padding-top: 8px; border-top: 2px solid #0F172A; font-size: 1.1em; font-weight: 700; }
.muted { color: #475569; }
.small { font-size: 0.85em; }
.strong { font-weight: 700; }
.banner {
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid #B45309;
  border-radius: 8px;
  background: #FFFBEB;
}
.banner.done { border-color: #15803D; background: #F0FDF4; }
.mark {
  width: 56px;
  height: 56px;
  margin: 8px auto 12px;
  border-radius: 50%;
  background: #15803D;
  color: #FFFFFF;
  font-size: 32px;
  line-height: 56px;
  text-align: center;
}
.button {
  display: block;
  width: 100%;
  min-height: 48px;
  margin: 16px 0 12px;
  padding: 10px 16px;
  border: 0;
  border-radius: 10px;
  background: #0F766E;
  color: #FFFFFF;
  font: inherit;
  font-size: 1.1em;
  font-weight: 700;
  cursor: pointer;
}
.button:focus-visible { outline: 3px solid #0F766E; outline-offset: 3px; }
.button.danger { background: #B91C1C; }
a { color: #0F766E; text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid #0F766E; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  html { color: #E5E7EB; background: #0B1220; }
  main { background: #111827; border-color: #334155; }
  .shop, .label, .muted { color: #94A3B8; }
  .section { border-color: #334155; }
  .due td { border-color: #E5E7EB; }
  .banner { border-color: #FBBF24; background: #1F2937; }
  .banner.done { border-color: #4ADE80; }
  .button { background: #2DD4BF; color: #0B1220; }
  .button:focus-visible, a:focus-visible { outline-color: #2DD4BF; }
  .button.danger { background: #F87171; }
  a { color: #2DD4BF; }
}
`;

/**
 * No scripts, frames or plug-ins; styles only from this page and Google Fonts; forms post back to
 * the site that served the page.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(STYLES).digest('base64')}' https://fonts.googleapis.com`,
  'font-src https://fonts.gstatic.com',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * A page for a customer's phone, such as a draft order's confirmation link: one column, large
 * touch targets, light or dark as the phone is. Like documents, it runs no scripts and loads Inter
 * and Noto Nastaliq Urdu from Google Fonts. It asks browsers not to send the page's address to
 * other sites, since such addresses carry secrets, and search engines not to index it.
 */
export function renderPage(options: PageOptions): RenderedPage {
  const page = html`<!doctype html>
    <html lang="en" dir="ltr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${options.title}</title>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link rel="stylesheet" href="${FONTS_URL}" />
        ${styleElement()}
      </head>
      <body>
        <main>${options.body}</main>
      </body>
    </html> `;
  return { html: toMarkup(page), contentSecurityPolicy: CONTENT_SECURITY_POLICY };
}

/** Built outside the template, so that its text is exactly what the policy's hash covers. */
function styleElement(): Html {
  return trusted(`<style>${STYLES}</style>`);
}

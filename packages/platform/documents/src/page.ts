import { createHash } from 'node:crypto';
import { FONTS_URL, TEXT_FONTS, URDU_FONTS } from './fonts.js';
import { html, toMarkup, trusted, type Html } from './html.js';

export interface PageOptions {
  /** For the browser tab, such as "Confirm your order · Zari". Never personal data. */
  title: string;
  body: Html;
  /**
   * The shop's colour, such as its theme's accent, "#B45309": its buttons take it, and its links
   * where they stay readable on white. Light pages only; dark ones keep the platform's colours.
   * Anything but a hex colour is ignored.
   */
  accent?: string | null;
  /**
   * The images the page shows, by their URLs, such as the shop's logo: its policy allows these
   * and no others, each at its own address. Only https URLs, or http on localhost.
   */
  images?: readonly string[];
}

/** A page and the Content-Security-Policy header to send with it. */
export interface RenderedPage {
  html: string;
  contentSecurityPolicy: string;
}

// Colours of @hatti/tokens' light and dark themes. Class names bodies use: shop, title, stack
// (Urdu under English), section, label, text (a block of paragraphs), num (with wrap, for text
// that may be long), total, due, banner (with done), mark, button (with danger; on a link too),
// field (a form's label and box), choice (a radio button's label, the button and a span for
// each language inside), error,
// center, muted, small, strong and select-all (a value tapped to copy, such as an IBAN). Urdu
// paragraphs are <p lang="ur" dir="rtl">. A box with something wrong has aria-invalid="true".
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
/* The shop's logo, in place of its name: as uploaded, kept within a header's size. */
.logo { display: block; max-width: 200px; max-height: 64px; margin: 0 auto; }
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
.num.wrap { white-space: normal; overflow-wrap: anywhere; }
.select-all { -webkit-user-select: all; user-select: all; }
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
  background: var(--accent, #0F766E);
  color: var(--on-accent, #FFFFFF);
  font: inherit;
  font-size: 1.1em;
  font-weight: 700;
  cursor: pointer;
}
.button:focus-visible { outline: 3px solid var(--link, #0F766E); outline-offset: 3px; }
.button.danger { background: #B91C1C; color: #FFFFFF; }
.button.secondary {
  margin: 8px 0 0;
  border: 2px solid var(--link, #0F766E);
  background: transparent;
  color: var(--link, #0F766E);
}
a.button { text-align: center; text-decoration: none; }
a { color: var(--link, #0F766E); text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid var(--link, #0F766E); outline-offset: 2px; }
.field { margin-top: 14px; }
.field .label { display: block; }
input, select {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid #475569;
  border-radius: 8px;
  background: #FFFFFF;
  color: inherit;
  font: inherit;
}
input:focus-visible, select:focus-visible { outline: 3px solid var(--link, #0F766E); outline-offset: 1px; }
[aria-invalid="true"] { border: 2px solid #B91C1C; }
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid #CBD5E1;
  border-radius: 8px;
  cursor: pointer;
}
.choice input {
  flex: none;
  width: 20px;
  height: 20px;
  min-height: 0;
  margin: 2px 0 0;
  padding: 0;
  accent-color: var(--link, #0F766E);
}
.choice:has(input:checked) { border: 2px solid var(--link, #0F766E); padding: 9px 11px; }
.choice span[lang] { display: block; }
.choice span[lang="ur"] { text-align: right; }
.error { margin-top: 4px; color: #B91C1C; font-size: 0.9em; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  html { color: #E5E7EB; background: #0B1220; }
  main { background: #111827; border-color: #334155; }
  .shop, .label, .muted { color: #94A3B8; }
  /* Logos are made for light pages: one with dark lines would vanish on a dark one. */
  .logo { padding: 6px 10px; border-radius: 8px; background: #FFFFFF; }
  .section { border-color: #334155; }
  .due td { border-color: #E5E7EB; }
  .banner { border-color: #FBBF24; background: #1F2937; }
  .banner.done { border-color: #4ADE80; }
  .button { background: #2DD4BF; color: #0B1220; }
  .button:focus-visible, a:focus-visible { outline-color: #2DD4BF; }
  .button.danger { background: #F87171; color: #0B1220; }
  .button.secondary { border-color: #2DD4BF; background: transparent; color: #2DD4BF; }
  a { color: #2DD4BF; }
  input, select { border-color: #94A3B8; background: #0B1220; }
  input:focus-visible, select:focus-visible { outline-color: #2DD4BF; }
  [aria-invalid="true"] { border-color: #F87171; }
  .choice { border-color: #334155; }
  .choice input { accent-color: #2DD4BF; }
  .choice:has(input:checked) { border-color: #2DD4BF; }
  .error { color: #F87171; }
}
`;

/**
 * No scripts, frames or plug-ins; styles only from this page and Google Fonts; images only those
 * given, each at its address; forms post back to the site that served the page. `styles` are the
 * page's style elements, by their text.
 */
function contentSecurityPolicy(styles: readonly string[], images: readonly string[] = []): string {
  const hashes = styles.map(
    (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`,
  );
  return [
    "default-src 'none'",
    `style-src ${hashes.join(' ')} https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    images.length > 0 && `img-src ${images.join(' ')}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join('; ');
}

const CONTENT_SECURITY_POLICY = contentSecurityPolicy([STYLES]);

/**
 * Where an image is, for the page's policy: its address without its query, which a policy
 * matches without, such as a signed URL's signature. Null for anything but an https URL, or http
 * on localhost, or one a policy can't name.
 */
function imageSource(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null;
  const source = `${parsed.origin}${parsed.pathname}`;
  // A policy's sources are split on spaces and semicolons, and quoted ones are keywords.
  return /[\s;,'"]/.test(source) ? null : source;
}

/** Text on the accent, and links in it, readable as WCAG asks of text: 4.5 to 1. */
const READABLE = 4.5;
const DARK_TEXT = '#0F172A';

/**
 * The shop's colour as the page's variables: its buttons in it, with white or dark text,
 * whichever reads better on it, or black on the few mid tones where neither reads, as black
 * always does then; its links in it where it reads on white, else the platform's. Null for
 * anything but a hex colour, which never reaches the style element.
 */
function accentStyles(accent: string | null | undefined): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent?.trim() ?? '');
  if (!match) return null;
  const hex =
    match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join('') : match[1]!;
  const colour = `#${hex.toUpperCase()}`;
  const onWhite = contrast(colour, '#FFFFFF');
  const onDark = contrast(colour, DARK_TEXT);
  const onAccent =
    Math.max(onWhite, onDark) < READABLE ? '#000000' : onWhite >= onDark ? '#FFFFFF' : DARK_TEXT;
  const link = onWhite >= READABLE ? colour : '#0F766E';
  return `:root { --accent: ${colour}; --on-accent: ${onAccent}; --link: ${link}; }`;
}

/** WCAG's contrast between two hex colours, from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A page for a customer's phone, such as a draft order's confirmation link: one column, large
 * touch targets, light or dark as the phone is. Like documents, it runs no scripts and loads Inter
 * and Noto Nastaliq Urdu from Google Fonts. It asks browsers not to send the page's address to
 * other sites, since such addresses carry secrets, and search engines not to index it.
 */
export function renderPage(options: PageOptions): RenderedPage {
  const accent = accentStyles(options.accent);
  const images = (options.images ?? []).map(imageSource).filter((source) => source !== null);
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
        ${styleElement(STYLES)} ${accent === null ? '' : styleElement(accent)}
      </head>
      <body>
        <main>${options.body}</main>
      </body>
    </html> `;
  return {
    html: toMarkup(page),
    contentSecurityPolicy:
      accent === null && images.length === 0
        ? CONTENT_SECURITY_POLICY
        : contentSecurityPolicy(accent === null ? [STYLES] : [STYLES, accent], images),
  };
}

/** Built outside the template, so that its text is exactly what the policy's hash covers. */
function styleElement(text: string): Html {
  return trusted(`<style>${text}</style>`);
}

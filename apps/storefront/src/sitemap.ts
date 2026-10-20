import type { HandledKind, SitemapEntry } from '@hatti/storefront-data';
import { escapeHtml, imageAddress } from './liquid.js';

// What a shop tells search engines (OS-09), as Shopify's storefronts do: robots.txt, and
// sitemaps of its products, collections, pages, blogs and articles at its own address, each in
// every language, with when each last changed and its image (ADR-236).

/** The most addresses in one sitemap file; the protocol allows 50,000. */
export const SITEMAP_SIZE = 5_000;

/** The sitemaps a shop has, by what they list, in the order the index names them. */
export const SITEMAP_KINDS: readonly HandledKind[] = [
  'product',
  'collection',
  'page',
  'blog',
  'article',
];

/** Where a kind's documents are on the storefront, as its sitemaps' names say. */
const PATHS: Readonly<Record<HandledKind, { plural: string; path: string }>> = {
  product: { plural: 'products', path: '/products/' },
  collection: { plural: 'collections', path: '/collections/' },
  page: { plural: 'pages', path: '/pages/' },
  blog: { plural: 'blogs', path: '/blogs/' },
  // An article's handle has its blog's: news/eid-edit (ADR-177).
  article: { plural: 'articles', path: '/blogs/' },
};

/** A sitemap's path, which the index names: /sitemaps/products-1.xml. */
export function sitemapPath(kind: HandledKind, page: number): string {
  return `/sitemaps/${PATHS[kind].plural}-${page}.xml`;
}

/** The kind and page a sitemap's file name asks for; null for any other name. */
export function sitemapOf(name: string): { kind: HandledKind; page: number } | null {
  const match = /^(products|collections|pages|blogs|articles)-([1-9]\d{0,4})\.xml$/.exec(name);
  if (!match) return null;
  const kind = SITEMAP_KINDS.find((each) => PATHS[each].plural === match[1])!;
  return { kind, page: Number(match[2]) };
}

/** How many sitemap files `count` addresses take. */
export function sitemapPages(count: number): number {
  return Math.ceil(count / SITEMAP_SIZE);
}

/** A kind's entries in the order its files list them, the same each time, so a handle stays in its file. */
export function inSitemapOrder(entries: readonly SitemapEntry[]): SitemapEntry[] {
  return [...entries].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}

/** W3C's date and time, to the second, as sitemaps give when something last changed. */
function lastmodOf(at: string): string {
  return `<lastmod>${escapeHtml(at.replace(/\.\d+(?=Z$)/, ''))}</lastmod>`;
}

/**
 * The index of a shop's sitemaps: one file per {@link SITEMAP_SIZE} addresses of each kind, each
 * with when the last of its addresses changed (ADR-608), from `entries` by kind in
 * {@link inSitemapOrder}.
 */
export function sitemapIndex(
  origin: string,
  entries: Readonly<Record<HandledKind, readonly SitemapEntry[]>>,
): string {
  const files = SITEMAP_KINDS.flatMap((kind) =>
    // The pages' sitemap always has the home page.
    Array.from(
      { length: Math.max(sitemapPages(entries[kind].length), kind === 'page' ? 1 : 0) },
      (_, i) => {
        // ISO times in UTC compare as text.
        const latest = entries[kind]
          .slice(i * SITEMAP_SIZE, (i + 1) * SITEMAP_SIZE)
          .reduce<string | null>((last, { at }) => (at && (!last || at > last) ? at : last), null);
        return (
          `<sitemap><loc>${escapeHtml(`${origin}${sitemapPath(kind, i + 1)}`)}</loc>` +
          `${latest ? lastmodOf(latest) : ''}</sitemap>`
        );
      },
    ),
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    files.join('\n') +
    '\n</sitemapindex>\n'
  );
}

/**
 * A page of a sitemap: the addresses of `entries`, in their order, `page` from 1, each with when
 * it last changed, its address in every language of `locales` and its image, whole; the pages'
 * first also has the home page. Null for a page past the last.
 */
export function sitemapPage(
  origin: string,
  kind: HandledKind,
  entries: readonly SitemapEntry[],
  page: number,
  languages: { locales: readonly string[]; defaultLocale: string },
): string | null {
  const listed = entries
    .slice((page - 1) * SITEMAP_SIZE, page * SITEMAP_SIZE)
    .map((entry) => ({ path: `${PATHS[kind].path}${entry.handle}`, ...entry }));
  if (kind === 'page' && page === 1)
    listed.unshift({ path: '/', handle: '', at: null, image: null });
  if (listed.length === 0) return null;
  const addressIn = (code: string, path: string) => {
    if (code === languages.defaultLocale) return `${origin}${path}`;
    return `${origin}/${code}${path === '/' ? '' : path}`;
  };
  const urls = listed.map(({ path, at, image }) => {
    const alternates =
      languages.locales.length > 1
        ? languages.locales.map(
            (code) =>
              `<xhtml:link rel="alternate" hreflang="${escapeHtml(code)}" ` +
              `href="${escapeHtml(addressIn(code, path))}"/>`,
          )
        : [];
    const lastmod = at ? lastmodOf(at) : '';
    const picture = image
      ? `<image:image><image:loc>${escapeHtml(imageAddress(image, origin, null))}</image:loc>` +
        '</image:image>'
      : '';
    return (
      `<url><loc>${escapeHtml(addressIn(languages.defaultLocale, path))}</loc>${lastmod}` +
      `${alternates.join('')}${picture}</url>`
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:xhtml="http://www.w3.org/1999/xhtml" ' +
    'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
    urls.join('\n') +
    '\n</urlset>\n'
  );
}

// robots.txt is built where the core's tester reads it too (ADR-616).
export { robotsTxt } from '@hatti/storefront-api';

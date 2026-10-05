import type { HandledKind } from '@hatti/storefront-data';
import { escapeHtml } from './liquid.js';

// What a shop tells search engines (OS-09), as Shopify's storefronts do: robots.txt, and
// sitemaps of its products, collections, pages, blogs and articles at its own address, each in
// every language.

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

/** The index of a shop's sitemaps: one file per {@link SITEMAP_SIZE} addresses of each kind. */
export function sitemapIndex(
  origin: string,
  counts: Readonly<Record<HandledKind, number>>,
): string {
  const entries = SITEMAP_KINDS.flatMap((kind) =>
    // The pages' sitemap always has the home page.
    Array.from(
      { length: Math.max(sitemapPages(counts[kind]), kind === 'page' ? 1 : 0) },
      (_, i) =>
        `<sitemap><loc>${escapeHtml(`${origin}${sitemapPath(kind, i + 1)}`)}</loc></sitemap>`,
    ),
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.join('\n') +
    '\n</sitemapindex>\n'
  );
}

/**
 * A page of a sitemap: the addresses of `handles`, in their order, `page` from 1, each with its
 * address in every language of `locales`; the pages' first also has the home page. Null for a
 * page past the last.
 */
export function sitemapPage(
  origin: string,
  kind: HandledKind,
  handles: readonly string[],
  page: number,
  languages: { locales: readonly string[]; defaultLocale: string },
): string | null {
  const paths = handles
    .slice((page - 1) * SITEMAP_SIZE, page * SITEMAP_SIZE)
    .map((handle) => `${PATHS[kind].path}${handle}`);
  if (kind === 'page' && page === 1) paths.unshift('/');
  if (paths.length === 0) return null;
  const addressIn = (code: string, path: string) => {
    if (code === languages.defaultLocale) return `${origin}${path}`;
    return `${origin}/${code}${path === '/' ? '' : path}`;
  };
  const urls = paths.map((path) => {
    const alternates =
      languages.locales.length > 1
        ? languages.locales.map(
            (code) =>
              `<xhtml:link rel="alternate" hreflang="${escapeHtml(code)}" ` +
              `href="${escapeHtml(addressIn(code, path))}"/>`,
          )
        : [];
    return (
      `<url><loc>${escapeHtml(addressIn(languages.defaultLocale, path))}</loc>` +
      `${alternates.join('')}</url>`
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls.join('\n') +
    '\n</urlset>\n'
  );
}

/**
 * robots.txt: crawlers may fetch pages, in every language, but not carts, checkouts, searches,
 * the editor's routes, previews, other sort orders of a listing, or sections alone; and the
 * sitemap is at the shop's address. The shop's own rules (ADR-055) follow the platform's: those
 * before any `User-agent` of its own are for every crawler, beside the platform's; its groups
 * come after, and its sitemaps with the platform's.
 */
export function robotsTxt(
  origin: string,
  languages: { locales: readonly string[]; defaultLocale: string },
  rules = '',
): string {
  const prefixes = [
    '',
    ...languages.locales.filter((code) => code !== languages.defaultLocale).map((c) => `/${c}`),
  ];
  const lines = rules === '' ? [] : rules.split('\n');
  const sitemaps = lines.filter((line) => line.startsWith('Sitemap:'));
  const others = lines.filter((line) => !line.startsWith('Sitemap:'));
  const groupsAt = others.findIndex((line) => line.startsWith('User-agent:'));
  const forAll = groupsAt === -1 ? others : others.slice(0, groupsAt);
  const groups = groupsAt === -1 ? [] : others.slice(groupsAt);
  return [
    [
      'User-agent: *',
      ...prefixes.flatMap((prefix) =>
        ['/cart', '/checkout', '/search'].map((path) => `Disallow: ${prefix}${path}`),
      ),
      'Disallow: /checkouts/',
      'Disallow: /editor/',
      'Disallow: /*?*preview=',
      'Disallow: /*?*sort_by=',
      'Disallow: /*?*section_id=',
      'Disallow: /*?*sections=',
      // A blank line would end the group: the shop's rules for every crawler join it.
      ...forAll.filter((line) => line !== ''),
    ].join('\n'),
    groups.join('\n').trim(),
    [`Sitemap: ${origin}/sitemap.xml`, ...sitemaps].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

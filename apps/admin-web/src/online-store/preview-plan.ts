// What the theme editor's preview shows (ADR-325): a page of the storefront in a frame beside the
// editor, its sections rendered again as the merchant changes them, before anything is saved,
// through the protocol of the storefront's script in the frame (ADR-050).

import type { EditorFile, SectionList } from './theme-files';

/** The shop's pages of each kind a template may show, for the preview to open one. */
export interface Samples {
  /** An active product's handle. */
  product: string | null;
  pages: { handle: string; templateSuffix: string | null }[];
  blogs: { handle: string; templateSuffix: string | null }[];
  articles: { handle: string; templateSuffix: string | null; blog: string }[];
}

/**
 * A page of the storefront a template shows, for the preview to open: the home page, a list, or
 * one of the shop's own pages that asks for it, as an alternate a page, blog or post may; null
 * when no page shows it.
 */
export function samplePathOf(template: string, samples: Samples): string | null {
  const dot = template.indexOf('.');
  const base = dot === -1 ? template : template.slice(0, dot);
  const suffix = dot === -1 ? null : template.slice(dot + 1);
  const at = (...parts: string[]) => `/${parts.map(encodeURIComponent).join('/')}`;
  const asking = <T extends { templateSuffix: string | null }>(list: readonly T[]) =>
    list.find((each) => (each.templateSuffix || null) === suffix);
  if (base === 'page') {
    const page = asking(samples.pages);
    return page ? at('pages', page.handle) : null;
  }
  if (base === 'blog') {
    const blog = asking(samples.blogs);
    return blog ? at('blogs', blog.handle) : null;
  }
  if (base === 'article') {
    const article = asking(samples.articles);
    return article ? at('blogs', article.blog, article.handle) : null;
  }
  // The storefront shows the others' alternates on no page.
  if (suffix !== null) return null;
  switch (base) {
    case 'index':
      return '/';
    case 'product':
      return samples.product === null ? null : at('products', samples.product);
    case 'collection':
      return '/collections/all';
    case 'search':
      return '/search';
    case 'cart':
      return '/cart';
    case 'password':
      return '/password';
    case '404':
      return '/404';
    default:
      return null;
  }
}

/** A section ID as the storefront takes one to render. */
const SECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * A section's ID on the storefront's page: a template's goes by its key, a section group's by
 * the group's name and its key; null for one the storefront would not render by it.
 */
export function pageSectionId(filename: string, key: string): string | null {
  const group = /^sections\/([a-z0-9_-]+)\.json$/.exec(filename);
  const id = group ? `${group[1]}__${key}` : filename.startsWith('templates/') ? key : null;
  return id !== null && SECTION_ID.test(id) ? id : null;
}

/**
 * Where a section of the page is kept, by its ID there: in a section group the theme has, or in
 * the page's template.
 */
export function placeOfSection(
  id: string,
  template: string | null,
  files: readonly EditorFile[],
): { filename: string; key: string } | null {
  const at = id.indexOf('__');
  if (at > 0) {
    const filename = `sections/${id.slice(0, at)}.json`;
    if (files.some((file) => file.filename === filename)) {
      return { filename, key: id.slice(at + 2) };
    }
  }
  return template ? { filename: template, key: id } : null;
}

/** What the preview is asked to show of the editor's changes. */
export interface PreviewRender {
  /** The page's files changed since the preview last showed them. */
  changed: string[];
  /** The page's sections to render again, by their IDs there. */
  sections: string[];
  /** The page's files as the editor has them: those not as saved, and those changed. */
  files: Record<string, string>;
}

function listOf(json: string): SectionList | null {
  try {
    const list = JSON.parse(json) as SectionList | null;
    return list && Array.isArray(list.order) && typeof list.sections === 'object' ? list : null;
  } catch {
    return null;
  }
}

/**
 * What the preview needs to show the editor's changes to the page's files, each file as JSON:
 * the sections whose placement changed, or that show again, rendered with the files as they are
 * now. The script in the frame takes away what is hidden or removed and puts the rest in order.
 */
export function previewRender(
  onPage: readonly string[],
  shown: (filename: string) => string,
  now: (filename: string) => string,
  saved: (filename: string) => string,
): PreviewRender {
  const changed = onPage.filter((filename) => now(filename) !== shown(filename));
  const sections: string[] = [];
  for (const filename of changed) {
    const before = listOf(shown(filename));
    const after = listOf(now(filename));
    if (!after) continue;
    for (const key of new Set(after.order)) {
      const placement = after.sections[key];
      if (!placement || placement.disabled) continue;
      const was = before?.order.includes(key) ? before.sections[key] : undefined;
      if (was && !was.disabled && JSON.stringify(was) === JSON.stringify(placement)) continue;
      const id = pageSectionId(filename, key);
      if (id !== null) sections.push(id);
    }
  }
  const files = Object.fromEntries(
    onPage
      .filter((filename) => changed.includes(filename) || now(filename) !== saved(filename))
      .map((filename) => [filename, now(filename)]),
  );
  return { changed, sections, files };
}

/** The most sections the storefront renders for the editor at once. */
export const RENDER_MAX = 5;

/** IDs in groups of up to {@link RENDER_MAX}; one empty group for none, to put the page in order. */
export function renderGroups(sections: readonly string[]): string[][] {
  if (sections.length === 0) return [[]];
  const groups: string[][] = [];
  for (let at = 0; at < sections.length; at += RENDER_MAX) {
    groups.push(sections.slice(at, at + RENDER_MAX));
  }
  return groups;
}

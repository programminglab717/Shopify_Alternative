import { describe, expect, it } from 'vitest';
import {
  pageSectionId,
  placeOfSection,
  previewRender,
  renderGroups,
  samplePathOf,
  type Samples,
} from './preview-plan';
import type { EditorFile } from './theme-files';

const SAMPLES: Samples = {
  product: 'eid-lawn-3pc',
  pages: [
    { handle: 'about', templateSuffix: null },
    { handle: 'contact-us', templateSuffix: 'contact' },
  ],
  blogs: [{ handle: 'news', templateSuffix: '' }],
  articles: [{ handle: 'eid-edit', templateSuffix: null, blog: 'news' }],
};

const file = (filename: string): EditorFile => ({ filename, body: '{}', own: false, problems: [] });

describe("The theme editor's preview", () => {
  it("opens a page of the shop's for each template, or none", () => {
    expect(samplePathOf('index', SAMPLES)).toBe('/');
    expect(samplePathOf('product', SAMPLES)).toBe('/products/eid-lawn-3pc');
    expect(samplePathOf('collection', SAMPLES)).toBe('/collections/all');
    expect(samplePathOf('page', SAMPLES)).toBe('/pages/about');
    expect(samplePathOf('page.contact', SAMPLES)).toBe('/pages/contact-us');
    // An empty suffix is none, as Shopify takes it.
    expect(samplePathOf('blog', SAMPLES)).toBe('/blogs/news');
    expect(samplePathOf('article', SAMPLES)).toBe('/blogs/news/eid-edit');
    expect(samplePathOf('404', SAMPLES)).toBe('/404');
    // No page asks for it, no product to show, or an alternate no page of the kind takes.
    expect(samplePathOf('page.faq', SAMPLES)).toBeNull();
    expect(samplePathOf('product', { ...SAMPLES, product: null })).toBeNull();
    expect(samplePathOf('product.unstitched', SAMPLES)).toBeNull();
    expect(samplePathOf('lookbook', SAMPLES)).toBeNull();
    // Handles as paths.
    expect(samplePathOf('product', { ...SAMPLES, product: 'kurta?x' })).toBe('/products/kurta%3Fx');
  });

  it('names a section as the page does, and finds where it is kept from that name', () => {
    expect(pageSectionId('templates/index.json', 'banner')).toBe('banner');
    expect(pageSectionId('sections/header-group.json', 'announcement')).toBe(
      'header-group__announcement',
    );
    // Not one the storefront would render by its name.
    expect(pageSectionId('templates/index.json', 'two words')).toBeNull();
    expect(pageSectionId('config/settings_data.json', 'cart-drawer')).toBeNull();

    const files = ['sections/header-group.json', 'templates/index.json'].map(file);
    expect(placeOfSection('header-group__announcement', 'templates/index.json', files)).toEqual({
      filename: 'sections/header-group.json',
      key: 'announcement',
    });
    expect(placeOfSection('banner', 'templates/index.json', files)).toEqual({
      filename: 'templates/index.json',
      key: 'banner',
    });
    // A group the theme does not have is no group: the key is the template's.
    expect(placeOfSection('aside__menu', 'templates/index.json', files)).toEqual({
      filename: 'templates/index.json',
      key: 'aside__menu',
    });
    expect(placeOfSection('banner', null, files)).toBeNull();
  });

  it('renders the sections a change touches, with the files as the editor has them', () => {
    const list = (sections: Record<string, object>, order: string[]) =>
      JSON.stringify({ sections, order });
    const saved: Record<string, string> = {
      'templates/index.json': list(
        { a: { type: 'banner' }, b: { type: 'text' }, c: { type: 'text', disabled: true } },
        ['a', 'b', 'c'],
      ),
      'sections/footer-group.json': list({ f: { type: 'footer' } }, ['f']),
    };
    const now: Record<string, string> = {
      ...saved,
      // A's settings changed, B moved before it, C shown again, D added.
      'templates/index.json': list(
        {
          a: { type: 'banner', settings: { heading: 'Eid' } },
          b: { type: 'text' },
          c: { type: 'text' },
          d: { type: 'text' },
        },
        ['b', 'a', 'c', 'd'],
      ),
    };
    const onPage = ['templates/index.json', 'sections/footer-group.json'];
    const plan = previewRender(
      onPage,
      (filename) => saved[filename]!,
      (filename) => now[filename]!,
      (filename) => saved[filename]!,
    );
    expect(plan).toEqual({
      changed: ['templates/index.json'],
      sections: ['a', 'c', 'd'],
      files: { 'templates/index.json': now['templates/index.json'] },
    });

    // As shown already: nothing to send. Changed back to as saved: sent as saved, to show it.
    expect(
      previewRender(
        onPage,
        (filename) => now[filename]!,
        (filename) => now[filename]!,
        (filename) => saved[filename]!,
      ).changed,
    ).toEqual([]);
    expect(
      previewRender(
        onPage,
        (filename) => now[filename]!,
        (filename) => saved[filename]!,
        (filename) => saved[filename]!,
      ),
    ).toEqual({
      changed: ['templates/index.json'],
      sections: ['a'],
      files: { 'templates/index.json': saved['templates/index.json'] },
    });
  });

  it('asks for at most five sections at once', () => {
    expect(renderGroups([])).toEqual([[]]);
    expect(renderGroups(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      ['a', 'b', 'c', 'd', 'e'],
      ['f', 'g'],
    ]);
  });
});

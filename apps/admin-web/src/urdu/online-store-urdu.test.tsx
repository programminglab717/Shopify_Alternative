import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { htmlFromText } from '../online-store/page-body';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const MENU = {
  id: 'mnu_1',
  title: 'Main menu',
  handle: 'main-menu',
  isDefault: true,
  items: [
    { id: 'mni_1', title: 'Home', type: 'FRONTPAGE', resourceId: null, url: '/', items: [] },
    {
      id: 'mni_2',
      title: 'Shop',
      type: 'CATALOG',
      resourceId: null,
      url: '/collections/all',
      items: [
        {
          id: 'mni_3',
          title: 'Kurtas',
          type: 'COLLECTION',
          resourceId: 'col_1',
          url: '/collections/kurtas',
          items: [],
        },
      ],
    },
  ],
};

const BLOG = {
  id: 'blg_1',
  title: 'News',
  handle: 'news',
  commentPolicy: 'MODERATED',
  articlesCount: 0,
  articles: { nodes: [] },
};

const ARTICLE = {
  id: 'art_1',
  title: 'Eid lawn is here',
  handle: 'eid-lawn',
  isPublished: true,
  publishedAt: '2026-01-01T00:00:00Z',
  commentsCount: 0,
  body: '<p>Our Eid lawn is in the shop.</p>',
  summary: '<p>New lawn.</p>',
  tags: [],
  author: null,
  image: null,
  blog: { id: 'blg_1', title: 'News', handle: 'news', commentPolicy: 'MODERATED' },
  comments: { nodes: [] },
};

const PREFERENCES = {
  passwordEnabled: false,
  password: null,
  passwordMessage: '',
  maintenanceEnabled: false,
  maintenanceMessage: '',
  maintenanceUntil: null,
  seo: { title: 'Zari: lawn in Lahore', description: 'Lawn and bridal, delivered.' },
};

/** Each thing's words of the shop's own, as the core gives them, each with a digest of them. */
const CONTENT: Record<string, { key: string; value: string; digest: string }[]> = {
  mnu_1: [{ key: 'title', value: 'Main menu', digest: 'd_main' }],
  mni_1: [{ key: 'title', value: 'Home', digest: 'd_home' }],
  mni_2: [{ key: 'title', value: 'Shop', digest: 'd_shop' }],
  mni_3: [{ key: 'title', value: 'Kurtas', digest: 'd_kurtas' }],
  blg_1: [{ key: 'title', value: 'News', digest: 'd_news' }],
  art_1: [
    { key: 'title', value: 'Eid lawn is here', digest: 'd_eid' },
    { key: 'body_html', value: ARTICLE.body, digest: 'd_body' },
    { key: 'summary_html', value: ARTICLE.summary, digest: 'd_summary' },
  ],
  shop_1: [
    { key: 'meta_title', value: PREFERENCES.seo.title, digest: 'd_seo_title' },
    { key: 'meta_description', value: PREFERENCES.seo.description, digest: 'd_seo_text' },
  ],
};

/** A fake core keeping the Urdu it is sent. */
function core(role: StaffRole) {
  const urdu: Record<string, { key: string; value: string; outdated: boolean }[]> = {};
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Menus':
        return { menus: { nodes: [MENU] } };
      case 'Collections':
        return { collections: { nodes: [] } };
      case 'Pages':
        return { pages: { nodes: [] } };
      case 'Blog':
        return { blog: BLOG };
      case 'Article':
        return { article: ARTICLE };
      case 'StorefrontPreferences':
        return { onlineStorePreferences: PREFERENCES };
      case 'InUrdu':
        return {
          translatableResourcesByIds: {
            nodes: (variables.ids as string[])
              .filter((id) => CONTENT[id])
              .map((id) => ({
                resourceId: id,
                translatableContent: CONTENT[id],
                translations: urdu[id] ?? [],
              })),
          },
        };
      case 'TranslationsRegister': {
        const id = variables.resourceId as string;
        for (const each of variables.translations as { key: string; value: string }[]) {
          urdu[id] = [
            ...(urdu[id] ?? []).filter((other) => other.key !== each.key),
            { key: each.key, value: each.value, outdated: false },
          ];
        }
        return { translationsRegister: { userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const save = () =>
  act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' })));

describe("The online store's words in Urdu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts a menu's title and every link in Urdu, those under another set in", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/menus/mnu_1');

    const card = await screen.findByRole('region', { name: 'In Urdu' });
    await waitFor(() => expect(card.textContent).toContain('Not in Urdu yet'));
    fireEvent.click(screen.getByRole('link', { name: 'Write in Urdu' }));
    expect(await screen.findByRole('heading', { name: 'Main menu in Urdu' })).toBeTruthy();
    // Each link by its own words, the one under Shop a level in.
    const depth = (label: string) => screen.getByLabelText(label).parentElement!.className;
    expect(depth('Home in Urdu')).not.toMatch(/\bps-/);
    expect(depth('Kurtas in Urdu')).toMatch(/\bps-6\b/);
    type('Title in Urdu', 'مین مینیو');
    type('Kurtas in Urdu', 'کرتے');
    await save();

    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'mnu_1',
        translations: [
          { key: 'title', locale: 'ur', translatableContentDigest: 'd_main', value: 'مین مینیو' },
        ],
      },
      {
        resourceId: 'mni_3',
        translations: [
          { key: 'title', locale: 'ur', translatableContentDigest: 'd_kurtas', value: 'کرتے' },
        ],
      },
    ]);
  });

  it("puts an article's text and summary in Urdu, and its blog's title", async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/shop_1/online-store/articles/art_1/urdu');

    expect(await screen.findByRole('heading', { name: 'Eid lawn is here in Urdu' })).toBeTruthy();
    await screen.findByLabelText('Text in Urdu');
    type('Text in Urdu', '## عید\n\nہماری لان آ گئی۔');
    type('Summary in Urdu', 'نئی لان');
    await save();
    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'art_1',
        translations: [
          {
            key: 'body_html',
            locale: 'ur',
            translatableContentDigest: 'd_body',
            value: htmlFromText('## عید\n\nہماری لان آ گئی۔', { rtl: true }),
          },
          {
            key: 'summary_html',
            locale: 'ur',
            translatableContentDigest: 'd_summary',
            value: '<p>نئی لان</p>',
          },
        ],
      },
    ]);

    await act(() =>
      router.navigate({
        to: '/$shopId/online-store/blogs/$blogId',
        params: { shopId: 'shop_1', blogId: 'blg_1' },
      }),
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Write in Urdu' }));
    expect(await screen.findByRole('heading', { name: 'News in Urdu' })).toBeTruthy();
    await screen.findByLabelText('Title in Urdu');
    type('Title in Urdu', 'خبریں');
    await save();
    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister').at(-1)).toEqual({
      resourceId: 'blg_1',
      translations: [
        { key: 'title', locale: 'ur', translatableContentDigest: 'd_news', value: 'خبریں' },
      ],
    });
  });

  it("puts the home page's words for search engines in Urdu, kept by the shop itself", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=storefront');

    const card = await screen.findByRole('region', { name: 'In Urdu' });
    await waitFor(() => expect(card.textContent).toContain('Not in Urdu yet'));
    fireEvent.click(screen.getByRole('link', { name: 'Write in Urdu' }));
    expect(await screen.findByRole('heading', { name: 'Your home page in Urdu' })).toBeTruthy();
    type('Title for search engines in Urdu', 'زری: لاہور کی لان');
    type('Description for search engines in Urdu', 'لان اور برائیڈل، گھر تک۔');
    await save();
    await screen.findByText("Saved. Your store's Urdu pages show it in a moment.");
    expect(sentOf(fake, 'TranslationsRegister')).toEqual([
      {
        resourceId: 'shop_1',
        translations: [
          {
            key: 'meta_title',
            locale: 'ur',
            translatableContentDigest: 'd_seo_title',
            value: 'زری: لاہور کی لان',
          },
          {
            key: 'meta_description',
            locale: 'ur',
            translatableContentDigest: 'd_seo_text',
            value: 'لان اور برائیڈل، گھر تک۔',
          },
        ],
      },
    ]);
  });

  it('keeps menus to those who change them', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/menus/mnu_1/urdu');
    expect(
      await screen.findByText("Only owners and managers change the shop's menus."),
    ).toBeTruthy();
    expect(sentOf(fake, 'Menus')).toEqual([]);
  });
});

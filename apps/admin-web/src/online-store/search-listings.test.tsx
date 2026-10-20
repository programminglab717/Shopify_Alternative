import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const NONE = { title: null, description: null };
const SHOP = { url: 'https://zari.pk' };

const PAGE = {
  id: 'pag_1',
  title: 'Returns',
  handle: 'returns',
  seo: NONE,
  body: '<p>Seven days to send it back.</p>\n<p>Call us &amp; we&#39;ll help.</p>',
  isPublished: true,
  publishedAt: '2026-01-05T09:00:00Z',
};

const COLLECTION = {
  id: 'col_1',
  title: 'Eid edit',
  handle: 'eid-edit',
  seo: { title: 'Eid edit 2026', description: 'Lawn and chiffon picked for Eid.' },
  description: 'Picked for Eid',
  sortOrder: 'MANUAL',
  productsCount: 0,
  ruleSet: null,
  products: { nodes: [] },
};

const BLOG = {
  id: 'blg_1',
  title: 'News',
  handle: 'news',
  seo: NONE,
  commentPolicy: 'MODERATED',
  articlesCount: 0,
  articles: { nodes: [] },
};

const ARTICLE = {
  id: 'art_1',
  title: 'Eid lawn is here',
  handle: 'eid-lawn',
  seo: NONE,
  isPublished: true,
  publishedAt: '2026-01-05T09:00:00Z',
  commentsCount: 0,
  body: '<p>Our Eid lawn is in the shop.</p>',
  summary: '<p>New lawn, in time for Eid.</p>',
  tags: [],
  author: { name: 'Sana' },
  image: null,
  blog: { id: 'blg_1', title: 'News', handle: 'news', commentPolicy: 'MODERATED' },
  comments: { nodes: [] },
};

function core() {
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'Page':
        return { shop: SHOP, page: PAGE };
      case 'PageUpdate':
        return { pageUpdate: { page: { id: variables.id }, userErrors: [] } };
      case 'Collection':
        return { shop: SHOP, collection: COLLECTION };
      case 'CollectionUpdate':
        return { collectionUpdate: { collection: { id: 'col_1' }, userErrors: [] } };
      case 'Blog':
        return { shop: SHOP, blog: BLOG };
      case 'BlogUpdate':
        return {
          blogUpdate: {
            blog: null,
            userErrors: [{ field: ['blog', 'seo', 'title'], message: 'Title is too long' }],
          },
        };
      case 'Article':
        return { shop: SHOP, article: ARTICLE };
      case 'ArticleUpdate':
        return { articleUpdate: { article: { id: variables.id }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const preview = () => screen.findByRole('figure', { name: 'How a search engine lists it' });

describe('Search engine listings of collections, pages, blogs and articles (OS-09, ADR-601)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("previews a page's own title and text, and saves its own", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/pages/pag_1');

    const listing = await preview();
    expect(within(listing).getByText('zari.pk › pages › returns')).toBeTruthy();
    expect(within(listing).getByText('Returns')).toBeTruthy();
    expect(
      within(listing).getByText("Seven days to send it back. Call us & we'll help."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Returns and exchanges' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PageUpdate')).toEqual([
        { id: 'pag_1', page: { seo: { title: 'Returns and exchanges', description: '' } } },
      ]),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it("shows a collection's own listing, and saves it through collectionUpdate", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/collections/col_1');

    const listing = await preview();
    expect(within(listing).getByText('zari.pk › collections › eid-edit')).toBeTruthy();
    expect(within(listing).getByText('Eid edit 2026')).toBeTruthy();
    expect(within(listing).getByText('Lawn and chiffon picked for Eid.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Meta description'), { target: { value: '' } });
    expect(within(listing).getByText('Picked for Eid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionUpdate')).toEqual([
        { input: { id: 'col_1', seo: { title: 'Eid edit 2026', description: '' } } },
      ]),
    );
  });

  it("says what was wrong with a blog's, and keeps what was typed", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/blogs/blg_1');

    const listing = await preview();
    expect(within(listing).getByText('zari.pk › blogs › news')).toBeTruthy();
    // A blog's own description is the shop's, which the page does not have.
    expect(
      within(listing).getByText('No description yet: write one, or one is made from the page.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Zari news' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));
    expect(await screen.findByText('Title is too long')).toBeTruthy();
    expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Zari news');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it("previews an article at its blog's address, with its summary", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/articles/art_1');

    const listing = await preview();
    expect(within(listing).getByText('zari.pk › blogs › news › eid-lawn')).toBeTruthy();
    expect(within(listing).getByText('New lawn, in time for Eid.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Meta description'), {
      target: { value: 'Eid lawn, in the shop now.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ArticleUpdate')).toEqual([
        { id: 'art_1', article: { seo: { title: '', description: 'Eid lawn, in the shop now.' } } },
      ]),
    );
  });
});

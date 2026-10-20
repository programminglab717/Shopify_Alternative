import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeoListed } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';
import { problemsOf, undescribedImagesOf } from './seo-overview';

function listed(
  id: string,
  title: string,
  seo: { title?: string; description?: string } = {},
  own: Partial<SeoListed> = {},
): SeoListed {
  return {
    id,
    title,
    handle: title.toLowerCase().replace(/\W+/g, '-'),
    seo: { title: seo.title ?? null, description: seo.description ?? null },
    ...own,
  };
}

const LISTED: Record<string, SeoListed[]> = {
  SeoProducts: [
    listed('prd_1', 'Lawn suit', {}, { description: 'Three pieces, printed lawn.' }),
    listed('prd_2', 'Kurta', { description: 'A cotton kurta for every day.' }, { description: '' }),
    listed('prd_3', 'Shawl', {}, { description: '' }),
    listed(
      'prd_4',
      'Wedding lehenga',
      {
        title: 'Wedding lehenga in red with zardozi, hand embroidered in Lahore by our karigars',
        description: 'Red lehenga.',
      },
      {
        description: '',
        media: [
          { alt: '', mediaContentType: 'IMAGE' },
          { alt: 'Red lehenga, front', mediaContentType: 'IMAGE' },
          { alt: ' ', mediaContentType: 'IMAGE' },
          { alt: '', mediaContentType: 'VIDEO' },
        ],
      },
    ),
  ],
  SeoPages: [listed('pag_1', 'About us', { description: 'Who we are.' }, { body: '<p>Us</p>' })],
  SeoArticles: [
    listed(
      'art_1',
      'Eid looks',
      {},
      {
        body: '<p>Long text</p><img src="a.jpg" alt="Green lawn"><img src="b.jpg">',
        summary: 'Five looks for Eid.',
        blog: { handle: 'news' },
        image: { alt: 'Three suits' },
      },
    ),
  ],
};

function seoCore(role: StaffRole, hasNextPage = false) {
  return fakeCore(role, (operation) => {
    if (!operation.startsWith('Seo')) throw new Error(`unexpected ${operation}`);
    return {
      shop: { url: 'https://zari.hatti.pk' },
      listed: { nodes: LISTED[operation] ?? [], pageInfo: { hasNextPage } },
    };
  });
}

/** The row of a listing by its name, which its preview's title repeats unless it has its own. */
const rowOf = (name: string) => screen.getAllByText(name)[0]!.closest('a')!;

describe("Every page's search engine listing, in the admin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists those without a description first, kind by kind, each opening its page', async () => {
    vi.stubGlobal('fetch', seoCore('owner').fetcher);
    renderAdmin('/shop_1/online-store?tab=seo');

    await screen.findByText('2 of 4 without a description of their own.');
    expect(
      screen.getByText(
        '1 with images that say nothing of what they show, for search engines and screen readers.',
      ),
    ).toBeTruthy();
    // Described, but with photos that say nothing of what they show (ADR-618).
    const lehenga = rowOf('Wedding lehenga');
    expect(within(lehenga).getByText('2 images without a description')).toBeTruthy();
    expect(within(lehenga).getByText('Title cut short')).toBeTruthy();
    const lawn = rowOf('Lawn suit');
    expect(lawn.getAttribute('href')).toBe('/shop_1/products/prd_1');
    expect(within(lawn).getByText('No description')).toBeTruthy();
    // The storefront describes it by its own text, which the preview shows.
    expect(within(lawn).getByText('Three pieces, printed lawn.')).toBeTruthy();
    expect(within(lawn).getByText('zari.hatti.pk › products › lawn-suit')).toBeTruthy();
    expect(within(rowOf('Shawl')).getByText('Nothing to describe it')).toBeTruthy();
    // Described, so shown once asked for.
    expect(screen.queryByText('Kurta')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only those missing a description' }));
    expect(within(rowOf('Kurta')).queryByText('No description')).toBeNull();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'PAGE' } });
    await screen.findByText('0 of 1 without a description of their own.');
    expect(rowOf('About us').getAttribute('href')).toBe('/shop_1/online-store/pages/pag_1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only those missing a description' }));
    expect(
      screen.getByText('Each of these has a description of its own, and each of their images too.'),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'BLOG' } });
    await screen.findByText('None of these yet.');
  });

  it("shows more of a long list, and only the kinds a member's role keeps", async () => {
    const core = seoCore('marketer', true);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/online-store?tab=seo');

    // A marketer writes pages and blogs, not products.
    await screen.findByText('0 of the first 1 without a description of their own.');
    const kinds = within(screen.getByLabelText('Show')).getAllByRole('option');
    expect(kinds.map((each) => each.textContent)).toEqual(['Pages', 'Blogs', 'Articles']);

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ARTICLE' } });
    const eid = (await screen.findAllByText('Eid looks'))[0]!.closest('a')!;
    expect(eid.getAttribute('href')).toBe('/shop_1/online-store/articles/art_1');
    expect(within(eid).getByText('Five looks for Eid.')).toBeTruthy();
    expect(within(eid).getByText('1 image without a description')).toBeTruthy();
    expect(within(eid).getByText('zari.hatti.pk › blogs › news › eid-looks')).toBeTruthy();
    await press('Show more');
    await screen.findByText('The first 250 are shown here; find the others from their own pages.');
    expect(
      core.sent
        .filter((each) => each.operation === 'SeoArticles')
        .map((each) => each.variables.first),
    ).toEqual([100, 250]);
  });

  it('keeps the tab from those who keep no listings, and says what is wrong with each', async () => {
    vi.stubGlobal('fetch', seoCore('confirmation_agent').fetcher);
    renderAdmin('/shop_1/online-store?tab=seo');
    await screen.findByText("Your role does not write the shop's pages.");
    expect(screen.queryByRole('tab', { name: 'Search listings' })).toBeNull();

    expect(problemsOf(LISTED.SeoProducts![0]!)).toEqual(['NO_DESCRIPTION']);
    expect(problemsOf(LISTED.SeoProducts![2]!)).toEqual(['NOTHING']);
    expect(problemsOf(LISTED.SeoProducts![3]!)).toEqual(['TITLE_CUT', 'IMAGES']);
    // A product's photos, not its videos; an article's image and those in its text.
    expect(undescribedImagesOf(LISTED.SeoProducts![3]!)).toBe(2);
    expect(undescribedImagesOf(LISTED.SeoArticles![0]!)).toBe(1);
    expect(
      undescribedImagesOf(
        listed('art_2', 'Lawn', {}, { body: '<p>Lawn</p>', image: { alt: '' }, summary: null }),
      ),
    ).toBe(1);
    expect(undescribedImagesOf(listed('pag_3', 'Size guide', {}, { body: '<img alt="">' }))).toBe(
      1,
    );
    // Text of only tags or spaces says nothing.
    expect(problemsOf(listed('pag_2', 'Empty', {}, { body: '<p> </p>' }))).toEqual(['NOTHING']);
    expect(problemsOf(listed('prd_9', 'Cap', { description: 'x'.repeat(161) }))).toEqual([
      'DESCRIPTION_CUT',
    ]);
  });
});

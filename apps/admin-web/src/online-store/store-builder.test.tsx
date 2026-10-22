import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const DESCRIPTION = 'Zari sells unstitched lawn suits from Faisalabad.\n\nWe ship across Pakistan.';

const PLAN = {
  kit: 'FASHION',
  theme: 'lawn',
  themeName: 'Lawn',
  accentColour: '#9F1239',
  aboutHtml:
    '<p>Zari sells unstitched lawn suits from Faisalabad.</p>\n<p>We ship across Pakistan.</p>',
  seoTitle: 'Zari',
  seoDescription: 'Zari sells unstitched lawn suits from Faisalabad.',
};

describe('The store builder, in the admin (ONB-03)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what a description makes of the shop, then builds it, saying what it left', async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation === 'StoreBuildPlan') return { storeBuildPlan: PLAN };
      if (operation === 'StoreBuild') {
        return {
          storeBuild: {
            plan: PLAN,
            collectionsMade: 7,
            sizeChartsMade: 2,
            menuLinksAdded: 7,
            theme: { id: 'thm_2', name: 'Lawn', published: true },
            accentSet: true,
            seoSet: false,
            aboutPage: { id: 'pg_1', handle: 'about-us' },
            userErrors: [],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/online-store?tab=builder');

    await screen.findByRole('heading', { name: 'Build your store from a few lines' });
    fireEvent.click(screen.getByRole('button', { name: 'See what it makes' }));
    expect(await screen.findByText('Write at least 20 characters.')).toBeTruthy();

    type('What you sell', DESCRIPTION);
    fireEvent.click(screen.getByRole('button', { name: 'See what it makes' }));
    expect(await screen.findByText('Kind of shop: Fashion')).toBeTruthy();
    expect(screen.getByText('Theme: Lawn')).toBeTruthy();
    expect(screen.getByText('Theme colour: #9F1239')).toBeTruthy();
    expect(screen.getByText('We ship across Pakistan.')).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'StoreBuildPlan')?.variables).toEqual({
      description: DESCRIPTION,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Build my store' }));
    expect(
      await screen.findByText('Done: 7 collections, 2 size charts and 7 menu links made.'),
    ).toBeTruthy();
    expect(screen.getByText('Your About us page is at /pages/about-us.')).toBeTruthy();
    expect(
      screen.getByText('Your store is on Lawn now; the theme it was on is among your themes.'),
    ).toBeTruthy();
    expect(screen.getByText('Your home page kept the search engine words you set.')).toBeTruthy();
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'StoreBuild')?.variables).toEqual({
        input: { description: DESCRIPTION },
      }),
    );
  });
});

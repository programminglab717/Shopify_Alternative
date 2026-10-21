import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

/** What shoppers searched for, as the core reports it, over however many days it is asked. */
const REPORT = {
  searches: 412,
  foundNothing: 37,
  foundNothingRate: 0.0898,
  top: [
    { terms: 'lawn', searches: 120, foundNothing: 0 },
    { terms: 'khussa', searches: 1, foundNothing: 1 },
  ],
  nothingFound: [
    { terms: 'velvet shawl', searches: 30, foundNothing: 30 },
    { terms: 'khussa', searches: 1, foundNothing: 1 },
  ],
};

/** A fake core with the page's other sections quiet, and its searches as given. */
function core(report: typeof REPORT | null) {
  return fakeCore('marketer', (operation, variables) => {
    if (operation === 'StoreSearches') {
      return {
        storeSearches: report
          ? { days: variables.days, ...report }
          : {
              days: variables.days,
              searches: 0,
              foundNothing: 0,
              foundNothingRate: null,
              top: [],
              nothingFound: [],
            },
      };
    }
    throw new Error('not this time');
  });
}

describe('What shoppers search for, in analytics (SRC-06, ADR-684)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the searches, the share that found nothing, the most searched and those that found nothing', async () => {
    const fake = core(REPORT);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics');

    const section = await screen.findByRole('region', { name: 'What shoppers search for' });
    await within(section).findByText('412');
    expect(within(section).getByText('9.0%')).toBeTruthy();
    const row = (list: string, terms: string) =>
      within(within(section).getByText(list).closest('section')!)
        .getByRole('link', { name: terms })
        .closest('li')!.textContent;
    expect(row('Most searched', 'lawn')).toBe('lawn120 times');
    expect(row('Most searched', 'khussa')).toBe('khussaOnce');
    expect(row('Searches that found nothing', 'velvet shawl')).toBe('velvet shawl30 times');
    // Each opens the products list searched for its words.
    expect(
      within(section).getAllByRole('link', { name: 'velvet shawl' })[0]!.getAttribute('href'),
    ).toBe('/shop_1/products?q=velvet+shawl');

    // The period the page shows is the searches'.
    const asked = () =>
      fake.sent.filter((each) => each.operation === 'StoreSearches').map((each) => each.variables);
    expect(asked()).toEqual([{ days: 30 }]);
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => expect(asked()).toEqual([{ days: 30 }, { days: 7 }]));
  });

  it('says so when no one searched in these days', async () => {
    vi.stubGlobal('fetch', core(null).fetcher);
    renderAdmin('/shop_1/analytics');
    expect(await screen.findByText('No searches on your online store in these days.')).toBeTruthy();
    expect(screen.queryByText('Most searched')).toBeNull();
  });
});

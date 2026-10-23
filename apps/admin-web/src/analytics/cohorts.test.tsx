import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerCohortValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

/** A fake core with the page's other sections quiet, and the cohorts as given. */
function core(cohorts: CustomerCohortValue[]) {
  return fakeCore('owner', (operation, variables) => {
    if (operation === 'CustomerCohorts') {
      expect(variables).toEqual({ months: 12 });
      return { customerCohorts: cohorts };
    }
    throw new Error('not this time');
  });
}

describe('Customers who came back, in analytics (ANL-04, ADR-775)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each month's new customers and the share who ordered again in each month after", async () => {
    vi.stubGlobal(
      'fetch',
      core([
        { month: '2026-08', customers: 40, returned: [10, 6], orderedAgain: 14 },
        { month: '2026-09', customers: 0, returned: [0], orderedAgain: 0 },
        { month: '2026-10', customers: 25, returned: [], orderedAgain: 2 },
      ]).fetcher,
    );
    renderAdmin('/shop_1/analytics');

    const section = await screen.findByRole('region', { name: 'Customers who came back' });
    const august = await within(section).findByRole('row', { name: /August 2026/ });
    expect(
      within(august)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['40', '25%', '15%', '', '', '', '', '35%']);
    // A month without new customers has no shares; this month has none after it yet.
    const september = within(section).getByRole('row', { name: /September 2026/ });
    expect(within(september).getAllByRole('cell')[1]?.textContent).toBe('–');
    const october = within(section).getByRole('row', { name: /October 2026/ });
    expect(within(october).getAllByRole('cell')[1]?.textContent).toBe('');
    expect(within(section).getByRole('columnheader', { name: '+6 mo' })).toBeTruthy();
  });

  it('says there is nothing yet before any customer', async () => {
    vi.stubGlobal(
      'fetch',
      core([{ month: '2026-10', customers: 0, returned: [], orderedAgain: 0 }]).fetcher,
    );
    renderAdmin('/shop_1/analytics');

    const section = await screen.findByRole('region', { name: 'Customers who came back' });
    await within(section).findByText(
      'No customers yet. Once orders come in, you see here how many come back.',
    );
    expect(within(section).queryByRole('table')).toBeNull();
  });
});

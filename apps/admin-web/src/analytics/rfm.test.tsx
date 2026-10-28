import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RfmGroupValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const GRID: [RfmGroupValue['name'], RfmGroupValue['recency'], RfmGroupValue['frequency']][] = [
  ['CHAMPIONS', 'RECENT', 'MANY'],
  ['POTENTIAL_LOYALISTS', 'RECENT', 'FEW'],
  ['NEW_CUSTOMERS', 'RECENT', 'ONCE'],
  ['LOYAL', 'SLIPPING', 'MANY'],
  ['NEEDS_ATTENTION', 'SLIPPING', 'FEW'],
  ['ABOUT_TO_SLEEP', 'SLIPPING', 'ONCE'],
  ['CANT_LOSE', 'LAPSED', 'MANY'],
  ['AT_RISK', 'LAPSED', 'FEW'],
  ['LOST', 'LAPSED', 'ONCE'],
];

/** 40 customers: 10 champions, 20 new, 10 at risk. */
const COUNTS: Partial<Record<RfmGroupValue['name'], [number, string]>> = {
  CHAMPIONS: [10, '250000'],
  NEW_CUSTOMERS: [20, '60000'],
  AT_RISK: [10, '45000'],
};

function core(role: 'marketer' | 'accountant' = 'marketer') {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'CustomerRfm':
        return {
          customerRfm: {
            recentDays: variables.recentDays,
            lapsedDays: variables.lapsedDays,
            customers: 40,
            groups: GRID.map(([name, recency, frequency]) => ({
              name,
              recency,
              frequency,
              customers: COUNTS[name]?.[0] ?? 0,
              amountSpent: { amount: COUNTS[name]?.[1] ?? '0' },
              averageOrders: null,
              query: `${name.toLowerCase()} query`,
            })),
          },
        };
      case 'SegmentCreate':
        return { segmentCreate: { segment: { id: 'seg_9' }, userErrors: [] } };
      default:
        throw new Error('not this time');
    }
  });
}

describe('Customers by how recently and often they buy (ADR-887)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows each group with its share and spend, and saves one as a segment', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics');

    const section = (
      await screen.findByRole('heading', { name: 'Customers by how recently and often they buy' })
    ).closest('section')!;
    const cell = async (name: string) => (await within(section).findByText(name)).closest('li')!;
    expect((await cell('Champions')).textContent).toContain('1025%');
    expect((await cell('Champions')).textContent).toContain('Rs 250,000 spent');
    expect((await cell('At risk')).textContent).toContain('Lapsed, two or three delivered');
    // A group of none has nothing to save.
    expect(within(await cell('Lost')).queryByRole('button')).toBeNull();

    // The lines drawn further back.
    fireEvent.click(within(section).getByRole('tab', { name: 'Recent 90 days, lapsed 365' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'CustomerRfm').at(-1)!.variables,
      ).toEqual({ recentDays: 90, lapsedDays: 365 }),
    );

    fireEvent.click(within(section).getByRole('button', { name: 'Save At risk as a segment' }));
    await waitFor(() =>
      expect(fake.sent.filter((each) => each.operation === 'SegmentCreate')).toEqual([
        expect.objectContaining({ variables: { name: 'At risk', query: 'at_risk query' } }),
      ]),
    );
  });

  it("offers no segment to those who don't keep segments", async () => {
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/analytics');
    const section = (
      await screen.findByRole('heading', { name: 'Customers by how recently and often they buy' })
    ).closest('section')!;
    await within(section).findByText('Champions');
    expect(within(section).queryByRole('button', { name: /as a segment/ })).toBeNull();
  });
});

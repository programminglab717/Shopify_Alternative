import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const metric = (
  name: string,
  p75: number | null,
  rating: string | null,
  good = 0.9,
  over = false,
) => ({ metric: name, samples: p75 === null ? 0 : 120, p75, over, good, rating });

const SPEED = {
  pageViews: 135,
  devices: [
    {
      device: 'MOBILE',
      pageViews: 120,
      score: 72,
      metrics: [
        metric('LCP', 4000, 'NEEDS_IMPROVEMENT', 0.55),
        metric('INP', 150, 'GOOD', 0.92),
        metric('CLS', 0.3, 'POOR', 0.69),
        metric('FCP', 1800, 'GOOD'),
        metric('TTFB', 20000, 'POOR', 0.1, true),
      ],
    },
    {
      device: 'DESKTOP',
      pageViews: 15,
      score: null,
      metrics: [metric('LCP', 1500, 'GOOD'), metric('INP', null, null)],
    },
  ],
  fixes: [
    { fix: 'LAYOUT_SHIFTS', device: 'MOBILE', kind: 'INDEX', metric: 'CLS', rating: 'POOR' },
    {
      fix: 'HEAVY_FIRST_IMAGE',
      device: 'MOBILE',
      kind: 'PRODUCT',
      metric: 'LCP',
      rating: 'NEEDS_IMPROVEMENT',
    },
  ],
};

function core(speed: unknown) {
  return fakeCore('owner', (operation) => {
    if (operation === 'StoreSpeed') return { storeSpeed: speed };
    throw new Error(`unexpected ${operation}`);
  });
}

describe("The online store's speed (OS-13, ADR-485)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('scores phones, says computers have too few visits, and lists what to fix', async () => {
    vi.stubGlobal('fetch', core(SPEED).fetcher);
    renderAdmin('/shop_1/online-store?tab=speed');

    expect(await screen.findByText('72 / 100')).toBeTruthy();
    const phones = screen.getByRole('heading', { name: 'On phones' }).parentElement!;
    const main = within(phones).getByText('Main content shows').closest('li')!;
    expect(within(main).getByText('4 s')).toBeTruthy();
    expect(within(main).getByText('Needs improvement')).toBeTruthy();
    expect(within(main).getByText('55% of page views good')).toBeTruthy();
    expect(within(phones).getByText('0.3')).toBeTruthy();
    expect(within(phones).getByText('150 ms')).toBeTruthy();
    expect(within(phones).getByText('over 20 s')).toBeTruthy();
    const computers = screen.getByRole('heading', { name: 'On computers' }).parentElement!;
    expect(
      within(computers).getByText('Not enough visits to score yet: 15 page views measured.'),
    ).toBeTruthy();
    // A measurement no browser made is left out.
    expect(within(computers).queryByText('Taps respond')).toBeNull();

    const shift = screen.getByRole('heading', { name: 'The page jumps as it loads' }).parentElement!
      .parentElement!;
    expect(within(shift).getByText('On phones, home page')).toBeTruthy();
    expect(within(shift).getByText('Poor')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The main picture shows late' })).toBeTruthy();
  });

  it('says there is nothing yet before any shopper is measured', async () => {
    vi.stubGlobal('fetch', core({ pageViews: 0, devices: [], fixes: [] }).fetcher);
    renderAdmin('/shop_1/online-store?tab=speed');
    expect(await screen.findByText('No measurements yet')).toBeTruthy();
  });
});

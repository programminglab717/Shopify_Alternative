import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { LIVE_EVERY_MS, percentOne } from './visits';

const DAY_MS = 86_400_000;

/** A period's sessions and how far they went, its conversion rate as the core works it out. */
const counts = (
  sessions: number,
  addedToCart: number,
  reachedCheckout: number,
  converted: number,
) => ({
  sessions,
  addedToCart,
  reachedCheckout,
  converted,
  conversionRate: sessions ? Math.round((converted / sessions) * 10_000) / 10_000 : null,
});

/** A fake core with the shop's sales and COD health quiet, and its visits as given. */
function core(visits: { now: ReturnType<typeof counts>; before: ReturnType<typeof counts> }) {
  let visitorsNow = 3;
  const fake = fakeCore('manager', (operation) => {
    switch (operation) {
      case 'Sales':
      case 'CodHealth':
        throw new Error('not this time');
      case 'StorefrontLiveView':
        return { storefrontLiveView: { visitorsNow: visitorsNow++, today: counts(41, 5, 3, 2) } };
      case 'StorefrontSessions':
        return {
          storefrontSessions: {
            totals: visits.now,
            periods: [
              { start: '2026-10-07T19:00:00Z', sessions: { sessions: 0, converted: 0 } },
              { start: '2026-10-08T19:00:00Z', sessions: { sessions: 41, converted: 1 } },
            ],
          },
          previous: { totals: visits.before },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
  return fake;
}

const asked = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The online store's visits in analytics", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows sessions against the period before, how far they went, and day by day', async () => {
    const fake = core({ now: counts(1240, 120, 60, 38), before: counts(1000, 90, 50, 30) });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics');

    const visits = await screen.findByRole('region', { name: 'Visits to your online store' });
    await within(visits).findByText('1,240');
    // Nearly a quarter more sessions, converting a little better than before.
    expect(within(visits).getByText('24% more')).toBeTruthy();
    expect(within(visits).getByText('2% more')).toBeTruthy();
    // 38 of 1,240 ordered: the conversion rate, and the funnel's last step.
    expect(within(visits).getAllByText('3.1%')).toHaveLength(2);
    const step = (name: string) => within(visits).getByText(name).closest('li')!.textContent;
    expect(step('Added to cart')).toBe('Added to cart120 sessions9.7%');
    expect(step('Reached checkout')).toBe('Reached checkout60 sessions4.8%');
    expect(step('Ordered')).toBe('Ordered38 sessions3.1%');
    expect(within(visits).getByLabelText('9 Oct 2026: 41 sessions, 1 ordered')).toBeTruthy();
    expect(within(visits).getByLabelText('8 Oct 2026: 0 sessions, 0 ordered')).toBeTruthy();

    // The month the page shows, and the month before it, ending where it starts.
    const month = asked(fake, 'StorefrontSessions')[0]!;
    const [from, before, previousFrom] = [month.from, month.before, month.previousFrom].map(
      (each) => Date.parse(String(each)),
    );
    expect(month.interval).toBe('DAY');
    expect(before! - from!).toBe(30 * DAY_MS);
    expect(from! - previousFrom!).toBe(30 * DAY_MS);

    fireEvent.click(screen.getByRole('tab', { name: 'Last 90 days' }));
    await waitFor(() => expect(asked(fake, 'StorefrontSessions')).toHaveLength(2));
    const quarter = asked(fake, 'StorefrontSessions')[1]!;
    expect(quarter.interval).toBe('WEEK');
    expect(Date.parse(String(quarter.from)) - Date.parse(String(quarter.previousFrom))).toBe(
      90 * DAY_MS,
    );
  });

  it('says who is on the store now and how today has gone, asking again every half minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = core({ now: counts(0, 0, 0, 0), before: counts(0, 0, 0, 0) });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics');

    const live = (await screen.findByRole('heading', { name: 'On your store now' })).closest(
      'section',
    )!;
    await within(live).findByText('3');
    const today = (label: string) => within(live).getByText(label).nextElementSibling?.textContent;
    expect(today('Sessions today')).toBe('41');
    expect(today('Added to cart')).toBe('5');
    expect(today('Ordered')).toBe('2');
    // No sessions in these days or the days before: said so, and nothing else.
    expect(await screen.findByText('No visits to your online store in these days.')).toBeTruthy();
    expect(screen.queryByText('Conversion rate')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(LIVE_EVERY_MS));
    await within(live).findByText('4');
    expect(asked(fake, 'StorefrontLiveView')).toHaveLength(2);
  });

  it('works out shares to a place', () => {
    expect(percentOne(0.0306)).toBe('3.1%');
    expect(percentOne(0)).toBe('0.0%');
    expect(percentOne(null)).toBe('–');
  });
});

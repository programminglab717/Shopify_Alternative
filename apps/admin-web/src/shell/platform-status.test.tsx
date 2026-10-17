import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformIncidentValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const OUTAGE: PlatformIncidentValue = {
  id: 'inc_1',
  kind: 'INCIDENT',
  impact: 'DEGRADED',
  status: 'IDENTIFIED',
  components: ['COURIERS', 'CHECKOUT'],
  title: 'PostEx bookings failing',
  titleUr: 'پوسٹ ایکس بکنگ ناکام',
  startsAt: '2026-10-17T08:00:00Z',
  endsAt: null,
  latestUpdate: {
    status: 'IDENTIFIED',
    body: "PostEx's API is down; bookings go through once it is back.",
    bodyUr: 'پوسٹ ایکس کا نظام بند ہے؛ بکنگ اس کے واپس آتے ہی ہو جائے گی۔',
    postedAt: '2026-10-17T08:10:00Z',
  },
};

const MAINTENANCE: PlatformIncidentValue = {
  id: 'inc_2',
  kind: 'MAINTENANCE',
  impact: 'OUTAGE',
  status: 'SCHEDULED',
  components: ['ADMIN'],
  title: 'Database upgrade',
  titleUr: null,
  startsAt: '2026-10-17T21:00:00Z',
  endsAt: '2026-10-17T21:20:00Z',
  latestUpdate: {
    status: 'SCHEDULED',
    body: 'The admin is down for 20 minutes.',
    bodyUr: null,
    postedAt: '2026-10-17T06:00:00Z',
  },
};

describe("Hatti's status above every page of the admin (BIL-06)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says what goes on at Hatti and maintenance to come, in the staff's language, with a link to the status page", async () => {
    const core = fakeCore('packer', (operation) => {
      if (operation === 'PlatformStatus') {
        return {
          platformStatus: {
            statusPageUrl: 'https://api.hatti.pk/status',
            incidents: [MAINTENANCE, OUTAGE],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/more');

    const banner = await screen.findByRole('region', { name: "Hatti's status" });
    const [maintenance, outage] = within(banner).getAllByRole('status');
    expect(maintenance!.textContent).toContain('Database upgrade');
    expect(maintenance!.textContent).toContain('Maintenance planned · Down · Touches: Admin');
    // In the shop's time zone.
    expect(maintenance!.textContent).toMatch(/From 18 Oct.*2:00.*to 18 Oct.*2:20/);
    expect(outage!.textContent).toContain('PostEx bookings failing');
    expect(outage!.textContent).toContain(
      'Cause found · Slow or partly down · Touches: Courier bookings and tracking, Checkout',
    );
    expect(outage!.textContent).toContain("PostEx's API is down");
    expect(
      within(outage!).getByRole('link', { name: "Hatti's status page" }).getAttribute('href'),
    ).toBe('https://api.hatti.pk/status');

    // In Urdu, Hatti's words in Urdu where it gave them, its English where it did not.
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Urdu' }));
    const urdu = await screen.findByRole('region', { name: 'ہٹی کی صورتحال' });
    expect(urdu.textContent).toContain('پوسٹ ایکس بکنگ ناکام');
    expect(urdu.textContent).toContain('پوسٹ ایکس کا نظام بند ہے');
    expect(urdu.textContent).toContain('Database upgrade');
  });

  it('shows nothing while all is well', async () => {
    const core = fakeCore('owner', (operation) => {
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/more');
    await screen.findAllByRole('navigation', { name: 'Main' });
    // Hatti was asked, and all is well.
    await waitFor(() =>
      expect(
        core.fetcher.mock.calls.some(([, init]) => String(init?.body).includes('PlatformStatus')),
      ).toBe(true),
    );
    expect(screen.queryByRole('region', { name: "Hatti's status" })).toBeNull();
  });
});

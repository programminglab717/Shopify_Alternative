import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { keepSession } from './session';
import type { CourierCities, ShopFound, ShopStanding } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();

const ZARI: ShopFound = {
  id: 'shop_1',
  name: 'Zari',
  handle: 'zari',
  status: 'active',
  development: false,
  plan: 'growth',
  createdAt: '2026-01-10T05:00:00Z',
};

const STANDING: ShopStanding = {
  shop: ZARI,
  owner: { name: 'Sana Ahmed', email: 'sana@zari.pk', phone: '+923001234567' },
  verified: ['identity'],
  openReports: 2,
  openSupportRequests: 1,
  standingSignals: 0,
  downSince: null,
  supportAccess: { until: '2026-10-28T09:00:00Z', note: "Order #1043 won't ship" },
  actions: [
    {
      email: 'ayesha@hatti.pk',
      action: 'report.uphold',
      subject: 'rpt_1',
      at: '2026-10-27T05:00:00Z',
    },
  ],
};

const CITIES: CourierCities = {
  shops: [
    {
      cityKey: 'chak45',
      city: 'Chak 45',
      names: [
        { courierCity: 'CHAK 45 SB', shops: 2 },
        { courierCity: 'CHAK NO 45', shops: 1 },
      ],
      shared: null,
    },
  ],
  hatti: [{ city: 'Mandi Bahauddin', courierCity: 'MANDI BAHA UD DIN' }],
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeServer() {
  const sent: Sent[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ method: init?.method ?? 'GET', path, body });
    if (path.startsWith('/shops?query=')) {
      return json(200, { shops: path.includes('zar') ? [ZARI] : [] });
    }
    if (path === '/shops/shop_1') return json(200, STANDING);
    if (path === '/courier-cities') return json(200, { couriers: ['leopards', 'postex'] });
    if (path === '/courier-cities/leopards') return json(200, { shops: [], hatti: [] });
    if (path === '/courier-cities/postex') return json(200, CITIES);
    if (path === '/courier-cities/postex/keep') return json(200, { kept: body });
    if (path === '/courier-cities/postex/forget') return json(200, { forgotten: 'x' });
    if (path.startsWith('/actions')) return json(200, { actions: [] });
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return { fetcher, sent };
}

function renderConsole(path: string) {
  const router = createConsoleRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<App router={router} />);
  return router;
}

describe("Hatti's console: shops and couriers' city names (ADR-881)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSession({
      token: 'hcs_1',
      agent: { email: 'ayesha@hatti.pk', name: 'Ayesha', expiresAt: LATER },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('finds a shop and shows its standing', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    const router = renderConsole('/shops');
    fireEvent.change(await screen.findByLabelText('Name, handle or ID'), {
      target: { value: 'nobody' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('No shop is called that.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name, handle or ID'), { target: { value: 'zar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Zari' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/shops/shop_1'));

    expect(await screen.findByText('sana@zari.pk')).toBeTruthy();
    expect(screen.getByText('identity')).toBeTruthy();
    expect(screen.getByText(/Order #1043 won't ship/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '2 reports open' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '1 support request waiting' })).toBeTruthy();
    expect(screen.getByText('report.uphold')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Take it down' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/stores'));
    expect((screen.getByLabelText('Store’s handle') as HTMLInputElement).value).toBe('zari');
  });

  it("shows shops' names for a city by courier, and keeps and forgets Hatti's", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/cities');
    // The first courier, Leopards, has no names yet: neither Hatti's nor shops'.
    expect(await screen.findAllByText('None.')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: 'postex' } });
    expect(await screen.findByText('Chak 45')).toBeTruthy();
    expect(screen.getByText('CHAK 45 SB (2), CHAK NO 45 (1) · disputed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() =>
      expect(
        server.sent.find((each) => each.path === '/courier-cities/postex/forget')?.body,
      ).toEqual({ city: 'Mandi Bahauddin' }),
    );
    fireEvent.change(screen.getByLabelText('City, as shops write it'), {
      target: { value: 'Chak 45' },
    });
    fireEvent.change(screen.getByLabelText('The courier’s name for it'), {
      target: { value: 'CHAK 45 SB' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(
      await screen.findByText('Every shop’s parcels to Chak 45 go to postex as CHAK 45 SB.'),
    ).toBeTruthy();
  });
});

describe('Shops open to support (ADR-882)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSession({
      token: 'hcs_1',
      agent: { email: 'ayesha@hatti.pk', name: 'Ayesha', expiresAt: LATER },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists them with what for, until when, and where to look in the admin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/support-access')
          ? new Response(
              JSON.stringify({
                shops: [
                  {
                    shop: { id: 'shop_1', name: 'Zari', handle: 'zari' },
                    note: "Order #1043 won't ship",
                    grantedBy: 'Sana Ahmed',
                    since: '2026-10-28T05:00:00Z',
                    until: '2026-10-28T06:00:00Z',
                    adminUrl: 'https://admin.hatti.pk/shop_1',
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify({ actions: [] }), { status: 200 }),
      ),
    );
    renderConsole('/access');
    expect(await screen.findByText("Order #1043 won't ship")).toBeTruthy();
    expect(screen.getByText(/^Sana Ahmed allowed it/)).toBeTruthy();
    const look = screen.getByRole('link', { name: 'Look in the admin' });
    expect(look.getAttribute('href')).toBe('https://admin.hatti.pk/shop_1');
    expect(look.getAttribute('rel')).toBe('noreferrer noopener');
  });
});

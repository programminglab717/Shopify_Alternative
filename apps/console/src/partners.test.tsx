import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { keepSession } from './session';
import type { ExpertProfile, PartnerApp, PartnerOwed, PartnerTheme } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();

const APP: PartnerApp = {
  clientId: 'hca_1',
  name: 'Rang Reviews',
  partner: 'Rang Studio',
  appUrl: 'https://reviews.rang.pk',
  redirectUrls: ['https://reviews.rang.pk/back'],
  scopes: ['read_products'],
  listed: false,
  createdAt: '2026-10-28T05:00:00Z',
};

const THEME: PartnerTheme = {
  id: 'thls_1',
  name: 'Basant',
  description: 'A spring theme',
  designer: 'Rang Studio',
  base: 'hatti-base',
  price: 'Rs 5,000',
  listed: true,
  preview: { shopId: 'shop_9', themeId: 'thm_9' },
  updatedAt: '2026-10-28T05:00:00Z',
};

const EXPERT: ExpertProfile = {
  id: 'expt_1',
  businessName: 'Rang Studio',
  website: null,
  headline: 'Lawn stores, set up in a week',
  about: '',
  services: ['setup', 'design'],
  cities: [],
  languages: ['en', 'ur'],
  startingPrice: null,
  certified: true,
  listed: false,
  updatedAt: '2026-10-28T05:00:00Z',
};

const OWED: PartnerOwed = {
  id: 'usr_1',
  businessName: 'Rang Studio',
  email: 'hira@rang.pk',
  payout: { title: 'Rang Studio', iban: 'PK36SCBL0000001123456702' },
  owed: 'Rs 898',
  entries: 2,
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeServer() {
  const sent: Sent[] = [];
  const state = { app: APP, theme: THEME, owed: [OWED] };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ method: init?.method ?? 'GET', path, body });
    if (path === '/partner-apps/hca_1/list') {
      state.app = { ...APP, listed: true };
      return json(200, { app: state.app });
    }
    if (path === '/partner-themes/thls_1/unlist') {
      state.theme = { ...THEME, listed: false };
      return json(200, { theme: state.theme });
    }
    if (path === '/partner-apps') return json(200, { apps: [state.app] });
    if (path === '/partner-themes') return json(200, { themes: [state.theme] });
    if (path === '/experts') return json(200, { experts: [EXPERT] });
    if (path === '/partner-payouts/usr_1/pay') {
      state.owed = [];
      return json(200, { paid: 'Rs 898', nothingOwed: false });
    }
    if (path === '/partner-payouts') return json(200, { partners: state.owed });
    if (path.startsWith('/actions')) return json(200, { actions: [] });
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return { fetcher, sent };
}

function renderConsole(path: string) {
  render(<App router={createConsoleRouter(createMemoryHistory({ initialEntries: [path] }))} />);
}

describe("Hatti's console: partners' work and payouts (ADR-880)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSession({
      token: 'hcs_1',
      agent: { email: 'sana@hatti.pk', name: 'Sana', expiresAt: LATER },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists a partner's app once checked, and takes a theme back", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/partners');
    const app = (await screen.findByRole('heading', { name: /Rang Reviews/ })).closest('section')!;
    expect(within(app).getByText('Waiting for review')).toBeTruthy();
    expect(within(app).getByText('Asks for read_products')).toBeTruthy();
    fireEvent.click(within(app).getByRole('button', { name: 'Checked: list it' }));
    await waitFor(() => expect(within(app).getByText('Listed')).toBeTruthy());

    const theme = screen.getByRole('heading', { name: /Basant/ }).closest('section')!;
    expect(within(theme).getByText(/Rs 5,000 · on hatti-base/)).toBeTruthy();
    fireEvent.click(within(theme).getByRole('button', { name: 'Take it back' }));
    await waitFor(() => expect(within(theme).getByText('Waiting for review')).toBeTruthy());

    expect(screen.getByText(/Lawn stores, set up in a week/)).toBeTruthy();
    expect(screen.getByText(/· Certified/)).toBeTruthy();
    expect(server.sent.filter((each) => each.method === 'POST').map((each) => each.path)).toEqual([
      '/partner-apps/hca_1/list',
      '/partner-themes/thls_1/unlist',
    ]);
  });

  it('marks what a partner is owed paid, with the transfer’s reference', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/payouts');
    expect(await screen.findByRole('heading', { name: 'Rs 898 to Rang Studio' })).toBeTruthy();
    expect(screen.getByText('PK36SCBL0000001123456702')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('The bank transfer’s reference'), {
      target: { value: 'FT24109999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transferred: mark it paid' }));
    expect(await screen.findByText('No partner is owed anything.')).toBeTruthy();
    expect(
      server.sent
        .filter((each) => each.path === '/partner-payouts/usr_1/pay')
        .map((each) => each.body),
    ).toEqual([{ reference: 'FT24109999' }]);
  });
});

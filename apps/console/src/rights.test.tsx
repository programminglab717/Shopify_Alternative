import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { keepSession } from './session';
import type { RightsComplaint, SmsSender, StoreSignal } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();
const ZARI = { id: 'shop_1', name: 'Zari', handle: 'zari' };

const COMPLAINT: RightsComplaint = {
  id: 'ipc_1',
  shop: ZARI,
  kind: 'trademark',
  rightsOwner: 'Gul Ahmed',
  registration: 'TM 123456',
  complainant: 'Sana Iqbal',
  actingAs: 'agent',
  email: 'legal@example.pk',
  phone: null,
  listings: [{ id: 'prod_1', title: 'Gul lawn', url: 'https://zari.hatti.test/products/gul' }],
  details: 'Sold as Gul Ahmed lawn; it is a copy.',
  signature: 'Sana Iqbal',
  language: 'en',
  status: 'open',
  overdue: false,
  dueAt: '2026-10-30T05:00:00Z',
  createdAt: '2026-10-28T05:00:00Z',
  decidedBy: null,
  decision: null,
  counter: null,
  releasedAt: null,
  releasedBy: null,
  releaseNote: null,
};

const ANSWERED: RightsComplaint = {
  ...COMPLAINT,
  id: 'ipc_2',
  status: 'upheld',
  decidedBy: 'Ayesha',
  counter: {
    words: 'It is my own print, bought from a mill.',
    signature: 'Sana Ahmed',
    at: '2026-10-28T07:00:00Z',
    status: 'open',
    answer: null,
    answeredBy: null,
  },
};

const SIGNAL: StoreSignal = {
  shop: ZARI,
  kind: 'prepaid_unshipped',
  detail: { orders: 6 },
  firstSeenAt: '2026-10-27T05:00:00Z',
  lastSeenAt: '2026-10-28T05:00:00Z',
  clearedAt: null,
  clearedBy: null,
  note: null,
};

const SENDER: SmsSender = {
  id: 'snd_1',
  shop: ZARI,
  name: 'ZARI',
  status: 'waiting',
  createdAt: '2026-10-28T05:00:00Z',
  decidedAt: null,
  decidedBy: null,
  answer: null,
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeServer() {
  const sent: Sent[] = [];
  const state = {
    complaints: [COMPLAINT],
    answers: [ANSWERED],
    signals: [SIGNAL],
    senders: [SENDER],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ method: init?.method ?? 'GET', path, body });
    if (path === '/rights/ipc_1/uphold') {
      state.complaints = [];
      return json(200, { complaint: { ...COMPLAINT, status: 'upheld' }, held: 1 });
    }
    if (path === '/rights/ipc_2/release') {
      state.answers = [];
      return json(200, { complaint: ANSWERED, released: 1 });
    }
    if (path.startsWith('/rights-answers')) return json(200, { complaints: state.answers });
    if (path.startsWith('/rights')) return json(200, { complaints: state.complaints });
    if (path === '/products/prod_9/clear-screening') {
      return json(200, { product: { id: 'prod_9', title: 'Shisha suit', found: ['shisha'] } });
    }
    if (path === '/products/prod_0/clear-screening') {
      return json(404, { error: { code: 'NOT_FOUND', message: 'No such product' } });
    }
    if (path === '/shops/zari/signals/prepaid_unshipped/clear') {
      state.signals = [];
      return json(200, { cleared: true });
    }
    if (path.startsWith('/signals')) return json(200, { signals: state.signals });
    if (path === '/sms-senders/snd_1/approve') {
      return json(409, {
        error: {
          code: 'NOT_VERIFIED',
          message: "Hatti hasn't verified the shop: its sender waits for that",
        },
      });
    }
    if (path === '/shops/zari/sms-sender/revoke') {
      return json(200, { sender: { ...SENDER, status: 'revoked' } });
    }
    if (path.startsWith('/sms-senders')) return json(200, { senders: state.senders });
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

const posted = (server: ReturnType<typeof fakeServer>, path: string) =>
  server.sent
    .filter((each) => each.method === 'POST' && each.path === path)
    .map((each) => each.body);

describe("Hatti's console: rights, scam signs and sender names (ADR-878)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSession({
      token: 'hcs_1',
      agent: { email: 'bilal@hatti.pk', name: 'Bilal', expiresAt: LATER },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("upholds a complaint, lets an answered one's listings go, and clears a listing", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/rights');
    const open = (await screen.findAllByText('Sold as Gul Ahmed lawn; it is a copy.'))[0]!.closest(
      'section',
    )!;
    expect(within(open).getByText('trademark of Gul Ahmed (TM 123456)')).toBeTruthy();
    expect(within(open).getByRole('link', { name: 'Gul lawn' }).getAttribute('href')).toBe(
      'https://zari.hatti.test/products/gul',
    );
    fireEvent.change(
      within(open).getByLabelText("Why, as the store's owner or the complainant is told"),
      { target: { value: 'The label copies their mark' } },
    );
    fireEvent.click(within(open).getByRole('button', { name: 'Uphold: take the listings down' }));
    expect(await screen.findByText('No rights complaint is open.')).toBeTruthy();
    expect(posted(server, '/rights/ipc_1/uphold')).toEqual([
      { note: 'The label copies their mark' },
    ]);

    // The owner's answer is a section of its complaint's card.
    const answer = screen.getByText('It is my own print, bought from a mill.').closest('section')!;
    const answered = answer.parentElement!.closest('section')!;
    expect(within(answered).getByText(/Its owner answers, sworn as Sana Ahmed/)).toBeTruthy();
    fireEvent.change(
      within(answered).getByLabelText('Why the listings go back on sale, as the owner is told'),
      { target: { value: 'Gul Ahmed withdrew it' } },
    );
    fireEvent.click(within(answered).getByRole('button', { name: 'Let the listings go' }));
    expect(await screen.findByText('No answer is waiting.')).toBeTruthy();
    expect(posted(server, '/rights/ipc_2/release')).toEqual([{ note: 'Gul Ahmed withdrew it' }]);

    fireEvent.change(screen.getByLabelText('Product’s ID'), { target: { value: 'prod_0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    expect(await screen.findByText('No such product')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Product’s ID'), { target: { value: 'prod_9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    expect(await screen.findByText('Shisha suit is cleared (it named shisha).')).toBeTruthy();
  });

  it('clears a sign of a scam store with why', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/signals');
    expect(await screen.findByText('A young store keeping paid orders unshipped')).toBeTruthy();
    expect(screen.getByText(/"orders": 6/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Why it is nothing'), {
      target: { value: 'Pre-orders for Eid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    expect(await screen.findByText('No sign stands.')).toBeTruthy();
    expect(posted(server, '/shops/zari/signals/prepaid_unshipped/clear')).toEqual([
      { note: 'Pre-orders for Eid' },
    ]);
  });

  it('says why a sender name waits, and takes one back', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/senders');
    expect(await screen.findByText('ZARI')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText("Hatti hasn't verified the shop: its sender waits for that"),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Store’s handle'), { target: { value: 'zari' } });
    fireEvent.change(screen.getByLabelText('Why, as the shop is told'), {
      target: { value: 'Jazz took it back' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(await screen.findByText('ZARI is taken back; the shop is told.')).toBeTruthy();
    expect(posted(server, '/shops/zari/sms-sender/revoke')).toEqual([
      { answer: 'Jazz took it back' },
    ]);
  });
});

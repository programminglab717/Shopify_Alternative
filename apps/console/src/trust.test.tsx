import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { keepSession } from './session';
import type { StoreAppeal, StoreReport, Takedown, Verification } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();
const ZARI = { id: 'shop_1', name: 'Zari', handle: 'zari' };

const REPORT: StoreReport = {
  id: 'rpt_1',
  shop: ZARI,
  openOfShop: 2,
  reason: 'never_delivered',
  details: 'Paid an advance and nothing came.',
  phone: '+923001234567',
  orderName: '#1043',
  pageUrl: null,
  language: 'en',
  status: 'open',
  overdue: true,
  dueAt: '2026-10-27T05:00:00Z',
  createdAt: '2026-10-25T05:00:00Z',
  decidedAt: null,
  decidedBy: null,
  decision: null,
};

const TAKEDOWN: Takedown = {
  shop: ZARI,
  reason: 'scam',
  note: 'Advances taken for orders never sent',
  takenBy: 'Ayesha',
  createdAt: '2026-10-28T05:00:00Z',
  restoredAt: null,
  restoredBy: null,
  restoreNote: null,
};

const APPEAL: StoreAppeal = {
  id: 'apl_1',
  shop: ZARI,
  reason: 'scam',
  takedownNote: TAKEDOWN.note,
  words: 'Every order was sent; I have the receipts.',
  status: 'open',
  createdAt: '2026-10-28T06:00:00Z',
  answeredAt: null,
  answeredBy: null,
  answer: null,
};

const VERIFICATION: Verification = {
  id: 'vrf_1',
  shop: ZARI,
  level: 'identity',
  name: 'Sana Ahmed',
  cnic: '3520212345671',
  cnicLast4: '5671',
  ntn: null,
  status: 'waiting',
  documents: 2,
  createdAt: '2026-10-28T04:00:00Z',
  decidedAt: null,
  decidedBy: null,
  answer: null,
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** The console's server's trust queues, faked: what it lists as the test sets it, and what it was sent. */
function fakeServer() {
  const sent: Sent[] = [];
  const state = {
    reports: [REPORT],
    takedowns: [] as Takedown[],
    appeals: [] as StoreAppeal[],
    verifications: [VERIFICATION],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const refuse = (field: string, message: string) =>
    json(422, { error: { code: 'BLANK', message, fields: { [field]: 'BLANK' } } });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<
      string,
      string
    > | null;
    sent.push({ method: init?.method ?? 'GET', path, body });
    if (path.startsWith('/reports/rpt_1/decide')) {
      state.reports = [];
      return json(200, { report: { ...REPORT, status: body!.status } });
    }
    if (path.startsWith('/reports')) return json(200, { reports: state.reports });
    if (path === '/shops/zari/suspend') {
      if (!body!.note?.trim()) return refuse('note', 'Say why, as its owner is told');
      state.takedowns = [TAKEDOWN];
      state.appeals = [APPEAL];
      return json(200, { takedown: TAKEDOWN });
    }
    if (path === '/shops/zari/restore') {
      state.takedowns = [];
      state.appeals = [];
      return json(200, { takedown: { ...TAKEDOWN, restoredAt: '2026-10-28T08:00:00Z' } });
    }
    if (path.startsWith('/takedowns')) return json(200, { takedowns: state.takedowns });
    if (path === '/appeals/apl_1/refuse') {
      state.appeals = [];
      return json(200, { appeal: { ...APPEAL, status: 'refused' } });
    }
    if (path.startsWith('/appeals')) return json(200, { appeals: state.appeals });
    if (path === '/verifications/vrf_1/documents') {
      return json(200, { links: ['https://files.example/1', 'https://files.example/2'] });
    }
    if (path === '/verifications/vrf_1/refuse') {
      return refuse('answer', 'Say why, as the shop is told');
    }
    if (path === '/verifications/vrf_1/approve') {
      state.verifications = [];
      return json(200, { verification: { ...VERIFICATION, status: 'approved' } });
    }
    if (path === '/shops/zari/unverify') return json(200, { verifications: [] });
    if (path.startsWith('/verifications')) {
      return json(200, { verifications: state.verifications });
    }
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

describe("Hatti's console: reports, stores down and verifications (ADR-877)", () => {
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

  it('upholds a report, and goes on to take its store down', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    const router = renderConsole('/reports');
    expect(await screen.findByText('Paid an advance and nothing came.')).toBeTruthy();
    expect(screen.getByText(/^Overdue: was due/)).toBeTruthy();
    expect(screen.getByText('Never delivered · 2 reports of this store are open')).toBeTruthy();
    expect(screen.getByText(/Order #1043 · Reach them on \+923001234567/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Uphold' }));
    expect(await screen.findByText('What was done, or why not: say it first')).toBeTruthy();
    expect(posted(server, '/reports/rpt_1/decide')).toEqual([]);

    fireEvent.click(screen.getByRole('link', { name: 'Take Zari down' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/stores'));
    expect((screen.getByLabelText('Store’s handle') as HTMLInputElement).value).toBe('zari');
    expect((screen.getByLabelText('Why') as HTMLSelectElement).value).toBe('never_delivered');
    cleanup();

    renderConsole('/reports');
    fireEvent.change(await screen.findByLabelText('What was done, or why not'), {
      target: { value: 'Refunded through the courier' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Uphold' }));
    expect(await screen.findByText('No report is open.')).toBeTruthy();
    expect(posted(server, '/reports/rpt_1/decide')).toEqual([
      { note: 'Refunded through the courier', status: 'upheld' },
    ]);
  });

  it('takes a store down, refuses its appeal, and restores it', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/stores');
    expect(await screen.findByText('No store is down.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Store’s handle'), { target: { value: 'zari' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'scam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take it down' }));
    expect(await screen.findByText('Say why, as its owner is told')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What its owner is told'), {
      target: { value: TAKEDOWN.note },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take it down' }));
    expect(await screen.findByText('Zari is down; its owner is told.')).toBeTruthy();
    expect(posted(server, '/shops/zari/suspend').at(-1)).toEqual({
      reason: 'scam',
      note: TAKEDOWN.note,
    });

    // Its owner appeals; the page, opened again, shows it.
    cleanup();
    renderConsole('/stores');
    const appeal = (await screen.findByRole('heading', { name: 'Its owner appeals' })).closest(
      'section',
    )!;
    expect(within(appeal).getByText(APPEAL.words)).toBeTruthy();
    fireEvent.change(
      within(appeal).getByLabelText('Why the appeal is refused, as its owner is told'),
      { target: { value: 'The receipts are for other orders' } },
    );
    fireEvent.click(within(appeal).getByRole('button', { name: 'Refuse the appeal' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Its owner appeals' })).toBeNull(),
    );
    expect(posted(server, '/appeals/apl_1/refuse')).toEqual([
      { answer: 'The receipts are for other orders' },
    ]);

    fireEvent.change(screen.getByLabelText('Why it is open again, as its owner is told'), {
      target: { value: 'Refunded every advance' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore the store' }));
    expect(await screen.findByText('No store is down.')).toBeTruthy();
    expect(posted(server, '/shops/zari/restore')).toEqual([{ note: 'Refunded every advance' }]);
  });

  it("shows a verification's documents only when asked, and decides it", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/verifications');
    expect(await screen.findByText('The owner: Sana Ahmed · CNIC 3520212345671')).toBeTruthy();
    expect(server.sent.some((each) => each.path.endsWith('/documents'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show its 2 documents' }));
    const second = await screen.findByRole('link', { name: 'Document 2' });
    expect(second.getAttribute('href')).toBe('https://files.example/2');
    expect(second.getAttribute('rel')).toBe('noreferrer noopener');

    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }));
    expect(await screen.findByText('Say why, as the shop is told')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('No verification is waiting.')).toBeTruthy();
    expect(posted(server, '/verifications/vrf_1/approve')).toEqual([{ answer: '' }]);

    fireEvent.change(screen.getByLabelText('Store’s handle'), { target: { value: 'zari' } });
    fireEvent.change(screen.getByLabelText('Which'), { target: { value: 'business' } });
    fireEvent.change(screen.getByLabelText('Why, as the shop is told'), {
      target: { value: 'Its NTN is struck off' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(await screen.findByText('Taken back; the shop is told.')).toBeTruthy();
    expect(posted(server, '/shops/zari/unverify')).toEqual([
      { level: 'business', answer: 'Its NTN is struck off' },
    ]);
  });
});

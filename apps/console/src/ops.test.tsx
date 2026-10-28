import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createConsoleRouter } from './app';
import { keepSession } from './session';
import type { BillingTransfer, Incident } from './types';

const LATER = new Date(Date.now() + 8 * 3_600_000).toISOString();

const TRANSFER: BillingTransfer = {
  id: 'btr_1',
  shop: { id: 'shop_1', name: 'Zari' },
  invoiceName: 'HB-000123',
  reference: 'FT24100012',
  amount: 'Rs 2,999',
  reportedAt: '2026-10-28T05:00:00Z',
};

const INCIDENT: Incident = {
  id: 'inc_1',
  kind: 'incident',
  impact: 'degraded',
  components: ['couriers'],
  title: 'PostEx bookings failing',
  titleUr: null,
  status: 'investigating',
  startsAt: '2026-10-28T05:00:00Z',
  endsAt: null,
  resolvedAt: null,
  createdBy: 'Omar',
  updates: [
    {
      status: 'investigating',
      body: 'Bookings with PostEx fail; we are on it.',
      bodyUr: null,
      postedBy: 'Omar',
      postedAt: '2026-10-28T05:00:00Z',
    },
  ],
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeServer() {
  const sent: Sent[] = [];
  const state = { transfers: [TRANSFER], incidents: [] as Incident[] };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/console\/api/, '');
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<
      string,
      unknown
    > | null;
    sent.push({ method: init?.method ?? 'GET', path, body });
    if (path === '/billing-transfers/btr_1/confirm') {
      state.transfers = [];
      return json(200, {
        transfer: { outcome: 'short', invoiceName: 'HB-000123', left: 'Rs 999' },
      });
    }
    if (path === '/billing-transfers/statement') {
      return json(200, {
        credits: 2,
        matches: [
          {
            transfer: TRANSFER,
            credit: {
              row: 2,
              date: '05-11-2026',
              description: 'IBFT FROM SANA REF FT24100012',
              amount: 'Rs 2,999',
              received: '2999.00',
            },
            outcome: 'exact',
          },
        ],
        ambiguous: [],
        unmatched: [
          {
            row: 3,
            date: '05-11-2026',
            description: 'CASH DEPOSIT',
            amount: 'Rs 10,000',
            received: '10000.00',
          },
        ],
        moreUnmatched: 0,
      });
    }
    if (path === '/billing-transfers') return json(200, { transfers: state.transfers });
    if (path === '/incidents' && init?.method === 'POST') {
      if (!body!.title) {
        return json(422, {
          error: { code: 'BLANK', message: 'Give it a title', fields: { title: 'BLANK' } },
        });
      }
      state.incidents = [INCIDENT];
      return json(200, { incident: INCIDENT });
    }
    if (path === '/incidents/inc_1/update') {
      state.incidents = [];
      return json(200, { incident: { ...INCIDENT, status: body!.status } });
    }
    if (path.startsWith('/incidents')) return json(200, { incidents: state.incidents });
    if (path.startsWith('/actions')) return json(200, { actions: [] });
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return { fetcher, sent };
}

function renderConsole(path: string) {
  render(<App router={createConsoleRouter(createMemoryHistory({ initialEntries: [path] }))} />);
}

const posted = (server: ReturnType<typeof fakeServer>, path: string) =>
  server.sent
    .filter((each) => each.method === 'POST' && each.path === path)
    .map((each) => each.body);

describe("Hatti's console: transfers and the status page (ADR-879)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSession({
      token: 'hcs_1',
      agent: { email: 'omar@hatti.pk', name: 'Omar', expiresAt: LATER },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('confirms a transfer found short, saying what its invoice waits for', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/transfers');
    expect(await screen.findByRole('heading', { name: 'Rs 2,999 from Zari' })).toBeTruthy();
    expect(screen.getByText('FT24100012')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What came, in rupees, if not Rs 2,999'), {
      target: { value: '2,000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Found it: confirm' }));
    expect(await screen.findByText('No transfer waits.')).toBeTruthy();
    expect(posted(server, '/billing-transfers/btr_1/confirm')).toEqual([{ received: '2,000' }]);
  });

  it("matches transfers from Hatti's bank statement, confirmed one by one (ADR-883)", async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/transfers');
    const csv = 'Txn Date,Narration,Credit\n05-11-2026,IBFT FROM SANA REF FT24100012,2999.00';
    fireEvent.change(await screen.findByLabelText('The statement'), {
      target: { files: [new File([csv], 'statement.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText('2 credits read; 1 matched.')).toBeTruthy();
    expect(posted(server, '/billing-transfers/statement').at(-1)).toEqual({ csv });
    expect(screen.getByText('1 credit matched nothing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm for Rs 2,999' }));
    await waitFor(() =>
      expect(posted(server, '/billing-transfers/btr_1/confirm')).toEqual([{ received: '2999.00' }]),
    );
  });

  it('posts an incident to the status page, and updates it to its next status', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/status');
    expect(await screen.findByText('Nothing is going on.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Post it' }));
    expect(await screen.findByText('Give it a title')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('couriers'));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'PostEx bookings failing' },
    });
    fireEvent.change(screen.getByLabelText('What Hatti says'), {
      target: { value: 'Bookings with PostEx fail; we are on it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post it' }));
    expect(
      await screen.findByText('Posted: the status page and every admin show it.'),
    ).toBeTruthy();
    expect(posted(server, '/incidents').at(-1)).toEqual({
      kind: 'incident',
      impact: 'degraded',
      components: ['couriers'],
      title: 'PostEx bookings failing',
      titleUr: '',
      body: 'Bookings with PostEx fail; we are on it.',
      bodyUr: '',
    });

    expect(await screen.findByRole('heading', { name: 'PostEx bookings failing' })).toBeTruthy();
    expect((screen.getByLabelText('Now') as HTMLSelectElement).value).toBe('identified');
    fireEvent.change(screen.getByLabelText('What Hatti says now'), {
      target: { value: "PostEx's API is down." },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post the update' }));
    await waitFor(() =>
      expect(posted(server, '/incidents/inc_1/update')).toEqual([
        { status: 'identified', body: "PostEx's API is down." },
      ]),
    );
  });

  it('gives maintenance its times, as Pakistan keeps them', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetcher);
    renderConsole('/status');
    fireEvent.change(await screen.findByLabelText('What'), { target: { value: 'maintenance' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Database upgrade' } });
    fireEvent.change(screen.getByLabelText('Begins'), { target: { value: '2026-11-01T02:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-01T02:20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post it' }));
    await waitFor(() =>
      expect(posted(server, '/incidents').at(-1)).toMatchObject({
        kind: 'maintenance',
        startsAt: '2026-11-01T02:00+05:00',
        endsAt: '2026-11-01T02:20+05:00',
      }),
    );
  });
});

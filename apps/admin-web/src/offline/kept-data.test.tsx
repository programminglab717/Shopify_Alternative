import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFetch } from '../api/client';
import { SessionProvider } from '../auth/context';
import { SessionStore } from '../auth/session';
import { LocaleProvider } from '../i18n/locale';
import { createAdminRouter } from '../router';
import { fakeCore, LATER, signedIn } from '../test-support';
import {
  KEPT_KEY,
  KEPT_LIMITS,
  keepData,
  keepShopData,
  keptQueriesOf,
  restoreKept,
  startAsTheBrowserIs,
} from './kept-data';

const tally = (count: number) => ({ count, total: { amount: '0', currencyCode: 'PKR' } });

/** A core whose Home has `toConfirm` orders to confirm and nothing else to do. */
function core(toConfirm: number) {
  return fakeCore('owner', (operation) => {
    if (operation === 'SetupChecklist') {
      return { setupChecklist: { done: 8, total: 8, steps: [] } };
    }
    if (operation === 'HomeStock') {
      return { home: { lowStock: { low: 0, out: 0, threshold: 5 }, transfersToReceive: 0 } };
    }
    if (operation !== 'Home') throw new Error(`unexpected ${operation}`);
    return {
      shop: { timezone: 'Asia/Karachi' },
      home: {
        toConfirm: tally(toConfirm),
        toReview: tally(0),
        awaitingPayment: tally(0),
        transfersToCheck: tally(0),
        toPack: tally(0),
        toBook: tally(0),
        readyForPickup: tally(0),
        returning: tally(0),
        returnsToReceive: tally(0),
        cashToCollect: tally(0),
        lostToClaim: tally(0),
        claimsOpen: tally(0),
        parcelsUnseen: 0,
        today: {
          since: LATER,
          sales: tally(0),
          salesYesterday: tally(0),
          delivered: tally(0),
          returnedToOrigin: tally(0),
        },
      },
    };
  });
}

const offline = (value: boolean) => {
  Object.defineProperty(navigator, 'onLine', { value: !value, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? 'offline' : 'online'));
  });
};

/** The admin as App opens it: what the session kept put back, and kept again as it reads. */
function openAdmin(path: string) {
  const session = new SessionStore(browserFetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  startAsTheBrowserIs();
  restoreKept(queryClient, session.sessionId(), window.localStorage);
  const stop = keepShopData(queryClient, session, window.localStorage, 0);
  const router = createAdminRouter(session, createMemoryHistory({ initialEntries: [path] }));
  render(
    <LocaleProvider initial="en">
      <SessionProvider store={session}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </SessionProvider>
    </LocaleProvider>,
  );
  return { session, queryClient, stop };
}

const kept = () =>
  JSON.parse(window.localStorage.getItem(KEPT_KEY) ?? 'null') as {
    session: string;
    queries: { key: unknown[]; at: number }[];
  } | null;

describe("The shop's last data kept for offline use (ADR-514)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    onlineManager.setOnline(true);
  });

  it('keeps Home, the lists’ first pages, the orders and customers opened and the account, newest first', () => {
    const client = new QueryClient();
    const at = (n: number) => ({ updatedAt: 1_000 + n });
    client.setQueryData(['me'], { user: { id: 'usr_1' } }, at(1));
    client.setQueryData(
      ['admin', 'shop_1', 'home', null, { locationId: null }],
      { home: 1 },
      at(2),
    );
    client.setQueryData(
      ['admin', 'shop_1', 'orders', null, null, null],
      { pages: [{ page: 1 }, { page: 2 }], pageParams: [null, 'c1'] },
      at(3),
    );
    client.setQueryData(
      ['admin', 'shop_1', 'order', 'ord_1', { id: 'ord_1' }],
      { order: 1 },
      at(4),
    );
    client.setQueryData(['admin', 'shop_1', 'customer', 'cus_1', { id: 'cus_1' }], { c: 1 }, at(5));
    // Pages that are not kept.
    client.setQueryData(['admin', 'shop_1', 'staff', null], { staff: [] }, at(6));
    client.setQueryData(['push', 'browser'], { subscribed: true }, at(7));

    const queries = keptQueriesOf(client);
    expect(queries.map(({ key }) => key[2] ?? key[0])).toEqual([
      'customer',
      'order',
      'orders',
      'home',
      'me',
    ]);
    expect(queries.find(({ key }) => key[2] === 'orders')?.data).toEqual({
      pages: [{ page: 1 }],
      pageParams: [null],
    });
    expect(queries[0]?.at).toBe(1_005);

    // Put back for the session that kept it, each as old as it was.
    keepData(client, 'ses_1', window.localStorage);
    const later = new QueryClient();
    expect(restoreKept(later, 'ses_1', window.localStorage, 2_000)).toBe(5);
    const order = later.getQueryState(['admin', 'shop_1', 'order', 'ord_1', { id: 'ord_1' }]);
    expect(order?.data).toEqual({ order: 1 });
    expect(order?.dataUpdatedAt).toBe(1_004);
    expect(later.getQueryData(['admin', 'shop_1', 'staff', null])).toBeUndefined();
  });

  it('shows another session none of it, and none older than three days', () => {
    const client = new QueryClient();
    client.setQueryData(
      ['admin', 'shop_1', 'order', 'ord_1', null],
      { order: 1 },
      { updatedAt: 0 },
    );
    client.setQueryData(['me'], { user: 1 }, { updatedAt: KEPT_LIMITS.age + 10 });
    keepData(client, 'ses_1', window.localStorage);

    const old = new QueryClient();
    expect(restoreKept(old, 'ses_1', window.localStorage, KEPT_LIMITS.age + 20)).toBe(1);
    expect(old.getQueryData(['admin', 'shop_1', 'order', 'ord_1', null])).toBeUndefined();
    expect(old.getQueryData(['me'])).toEqual({ user: 1 });

    // Someone else signed in on the same phone: nothing shown, and what was kept forgotten.
    const other = new QueryClient();
    expect(restoreKept(other, 'ses_2', window.localStorage)).toBe(0);
    expect(other.getQueryData(['me'])).toBeUndefined();
    expect(window.localStorage.getItem(KEPT_KEY)).toBeNull();
    keepData(client, 'ses_1', window.localStorage);
    expect(restoreKept(new QueryClient(), null, window.localStorage)).toBe(0);
    expect(window.localStorage.getItem(KEPT_KEY)).toBeNull();
  });

  it('shows Home offline as Hatti last saw it, and fetches it again once online', async () => {
    signedIn();
    vi.stubGlobal('fetch', core(3).fetcher);
    const first = openAdmin('/shop_1');
    expect(await screen.findByText('3 orders to confirm')).toBeTruthy();
    await waitFor(() =>
      expect(kept()?.queries.map(({ key }) => key[2] ?? key[0])).toEqual(
        expect.arrayContaining(['home', 'me']),
      ),
    );
    expect(kept()?.session).toBe('ses_1');
    expect(screen.queryByText(/As Hatti last saw it/)).toBeNull();
    first.stop();
    cleanup();

    // The phone opens the admin again with no connection.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const unreachable = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', unreachable);
    const second = openAdmin('/shop_1');
    expect(await screen.findByText('3 orders to confirm')).toBeTruthy();
    expect(screen.getByText(/As Hatti last saw it, now\./)).toBeTruthy();
    expect(unreachable).not.toHaveBeenCalled();

    // Back online, Home is asked for again and says nothing of being old.
    vi.stubGlobal('fetch', core(4).fetcher);
    offline(false);
    expect(await screen.findByText('4 orders to confirm')).toBeTruthy();
    expect(screen.queryByText(/As Hatti last saw it/)).toBeNull();
    second.stop();
  });

  it('forgets it all when the session signs out', async () => {
    signedIn();
    vi.stubGlobal('fetch', core(2).fetcher);
    const { session, stop } = openAdmin('/shop_1');
    expect(await screen.findByText('2 orders to confirm')).toBeTruthy();
    await waitFor(() => expect(kept()).not.toBeNull());
    await act(async () => {
      await session.signOut();
    });
    expect(window.localStorage.getItem(KEPT_KEY)).toBeNull();
    stop();
  });
});

import { focusManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';
import { ASK_AGAIN_MS, freshOf } from './fresh-orders';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** The nth order placed: its ID sorts after those before it, as public IDs do. */
const placed = (n: number) => ({
  id: `ord_${String(n).padStart(4, '0')}`,
  name: `#${1000 + n}`,
  createdAt: LATER,
  stage: 'NEEDS_CONFIRMATION',
  paymentMethod: 'CASH_ON_DELIVERY',
  overPlanLimit: false,
  location: { id: 'loc_1', name: 'Main location' },
  totalPrice: rupees('2700'),
  customer: { displayName: 'Ayesha Khan' },
  shippingAddress: { name: 'Ayesha Khan', city: 'Lahore' },
  risk: { level: 'LOW' },
  lineItems: [{ quantity: 1 }],
});

/** A fake core whose shop is placed orders while its list is open, the newest first. */
function ordersCore(role: StaffRole, first: number[]) {
  let orders = first.map(placed);
  const fake = fakeCore(role, (operation, variables) => {
    const stage = variables.stage as string | null;
    const tab = orders.filter((order) => !stage || order.stage === stage);
    switch (operation) {
      case 'Orders': {
        const from = variables.after ? tab.findIndex(({ id }) => id === variables.after) + 1 : 0;
        const page = tab.slice(from, from + 50);
        return {
          orders: {
            nodes: page,
            pageInfo: { hasNextPage: tab.length > from + 50, endCursor: page.at(-1)?.id ?? null },
          },
          orderStageCounts: [],
        };
      }
      case 'FreshOrders': {
        const most = variables.first as number;
        return {
          orders: {
            nodes: tab.slice(0, most).map(({ id }) => ({ id })),
            pageInfo: { hasNextPage: tab.length > most },
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
  return {
    ...fake,
    place: (...numbers: number[]) => {
      orders = [...numbers.map(placed).reverse(), ...orders];
    },
  };
}

const sentOf = (fake: { sent: { operation: string; variables: unknown }[] }, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

/** The orders the list shows, by name, top to bottom. */
const rows = () => screen.queryAllByText(/^#\d{4}$/).map((each) => each.textContent);

const askAgain = () => act(() => vi.advanceTimersByTimeAsync(ASK_AGAIN_MS));

describe('Orders as they come, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.title = 'Hatti';
  });

  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says orders placed since above the list and in the title, and shows them when asked', async () => {
    const fake = ordersCore('owner', [2, 1]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders');

    await screen.findByText('#1002');
    // The list's own answer is the first: nothing is asked twice as it is read.
    expect(sentOf(fake, 'FreshOrders')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Select #1001'));

    fake.place(3, 4);
    await askAgain();
    await screen.findByRole('button', { name: 'Show 2 new orders' });
    expect(screen.getByText('2 new orders')).toBeTruthy();
    expect(document.title).toBe('(2) Hatti');
    // Nothing moved, even as they come back to the list.
    await act(async () => {
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(rows()).toEqual(['#1002', '#1001']);
    expect(sentOf(fake, 'Orders')).toHaveLength(1);
    expect(sentOf(fake, 'FreshOrders')).toEqual([{ first: 20, query: null, stage: null }]);

    await press('Show 2 new orders');
    await screen.findByText('#1004');
    expect(rows()).toEqual(['#1004', '#1003', '#1002', '#1001']);
    expect(screen.queryByRole('button', { name: /new order/ })).toBeNull();
    expect(document.title).toBe('Hatti');
    // The order chosen before is still chosen.
    expect(screen.getByText('1 selected')).toBeTruthy();

    fake.place(5);
    await askAgain();
    await screen.findByRole('button', { name: 'Show 1 new order' });
    expect(document.title).toBe('(1) Hatti');
  });

  it('reads the first page alone again, letting go of chosen orders it no longer shows', async () => {
    const fake = ordersCore(
      'manager',
      Array.from({ length: 52 }, (_, index) => 52 - index),
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders');

    await screen.findByText('#1052');
    await press('Show more');
    await screen.findByText('#1001');
    fireEvent.click(screen.getByLabelText('Select #1001'));
    fireEvent.click(screen.getByLabelText('Select #1052'));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fake.place(53);
    await askAgain();
    await press('Show 1 new order');
    await screen.findByText('#1053');
    expect(rows()).toHaveLength(50);
    expect(rows().at(-1)).toBe('#1004');
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it("shows orders at once on a tab with none, counts past a tab's newest twenty, and gives the title back", async () => {
    const fake = ordersCore('confirmation_agent', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders?stage=NEEDS_CONFIRMATION');

    await screen.findByText('No orders here.');
    fake.place(1);
    await askAgain();
    // No row to move: shown as it comes.
    await screen.findByText('#1001');
    expect(screen.queryByRole('button', { name: /new order/ })).toBeNull();
    expect(sentOf(fake, 'FreshOrders')).toEqual([
      { first: 20, query: null, stage: 'NEEDS_CONFIRMATION' },
    ]);

    fake.place(...Array.from({ length: 25 }, (_, index) => index + 2));
    await askAgain();
    await screen.findByRole('button', { name: 'Show 20+ new orders' });
    expect(document.title).toBe('(20+) Hatti');
    expect(rows()).toEqual(['#1001']);

    // Leaving the list gives the title back.
    fireEvent.click(screen.getByText('#1001'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /new order/ })).toBeNull());
    expect(document.title).toBe('Hatti');
  });

  it('counts as new only the orders newer than the newest shown', () => {
    const answer = (ids: string[], hasNextPage = false) => ({
      orders: { nodes: ids.map((id) => ({ id })), pageInfo: { hasNextPage } },
    });
    const ids = ['ord_01j9zk3m8q5v7w2x4y6z8a0b1e', 'ord_01j9zk3m8q5v7w2x4y6z8a0b1d'];
    expect(freshOf(answer([...ids, 'ord_01j9zk3m8q5v7w2x4y6z8a0b1c'], true), ids[1]!)).toEqual({
      count: 1,
      more: false,
    });
    // The newest shown has left the tab: those newer are new still, those older are not.
    expect(freshOf(answer([ids[0]!, 'ord_01j9zk3m8q5v7w2x4y6z8a0b1c']), ids[1]!)).toEqual({
      count: 1,
      more: false,
    });
    expect(freshOf(answer(ids, true), 'ord_01j9zk3m8q5v7w2x4y6z8a0b1c')).toEqual({
      count: 2,
      more: true,
    });
    expect(freshOf(answer(ids), null)).toEqual({ count: 2, more: false });
    expect(freshOf(undefined, null)).toEqual({ count: 0, more: false });
  });

  it('asks again every half minute on the home and at the Confirmation Desk', async () => {
    const tally = (count: number) => ({ count, total: rupees(String(count * 2700)) });
    let toConfirm = 1;
    const due: string[] = [];
    const fake = fakeCore('owner', (operation) => {
      switch (operation) {
        case 'SetupChecklist':
          return { setupChecklist: { done: 8, total: 8, steps: [] } };
        case 'Home':
          return {
            shop: { timezone: 'Asia/Karachi' },
            home: {
              toConfirm: tally(toConfirm),
              toReview: tally(0),
              awaitingPayment: tally(0),
              transfersToCheck: tally(0),
              toPack: tally(0),
              toBook: tally(0),
              returning: tally(0),
              returnsToReceive: tally(0),
              cashToCollect: tally(0),
              lostToClaim: tally(0),
              claimsOpen: tally(0),
              today: {
                since: LATER,
                sales: tally(0),
                salesYesterday: tally(0),
                delivered: tally(0),
                returnedToOrigin: tally(0),
              },
            },
          };
        case 'ConfirmationQueue':
          return {
            shop: { timezone: 'Asia/Karachi' },
            confirmationQueue: {
              callingNow: true,
              callingOpensAt: null,
              dueCount: due.length,
              laterCount: 0,
              overdueCount: 0,
              nodes: [],
            },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1');

    await screen.findByText('1 order to confirm');
    toConfirm = 3;
    await askAgain();
    await screen.findByText('3 orders to confirm');
    cleanup();

    renderAdmin('/shop_1/desk');
    await screen.findByText('No orders to call right now.');
    due.push('ord_0001');
    await askAgain();
    await screen.findByText('1 due');
    expect(screen.getByRole('button', { name: 'Take the next order' })).toBeTruthy();
  });
});

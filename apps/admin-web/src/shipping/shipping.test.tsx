import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const AGO = new Date(Date.now() - 3_600_000).toISOString();

function packed(id: string, name: string) {
  return {
    id,
    name,
    createdAt: AGO,
    stage: 'TO_BOOK',
    paymentMethod: 'CASH_ON_DELIVERY',
    overPlanLimit: false,
    totalPrice: pkr('5599.00'),
    customer: { displayName: 'Ayesha Khan' },
    shippingAddress: { name: 'Ayesha Khan', city: 'Karachi' },
    risk: { level: 'LOW' },
    lineItems: [{ quantity: 1 }],
  };
}

function booking(
  id: string,
  orderName: string,
  status: string,
  more: Record<string, unknown> = {},
) {
  return {
    id,
    orderId: `ord_${id}`,
    orderName,
    courierName: 'PostEx',
    status,
    parcelStatus: null,
    trackingNumber: null,
    error: null,
    createdAt: AGO,
    bookedAt: null,
    codAmount: pkr('5599.00'),
    ...more,
  };
}

const ACCOUNT = { id: 'acc_1', name: 'PostEx', courierName: 'PostEx', isDefault: true };

function shippingCore(accounts = [ACCOUNT]) {
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'Shipping':
        return {
          shop: { timezone: 'Asia/Karachi' },
          courierAccounts: accounts,
          courierBookings: {
            nodes: [
              booking('b1', '#1001', 'BOOKED', {
                parcelStatus: 'IN_TRANSIT',
                trackingNumber: 'CX-1001',
                bookedAt: AGO,
              }),
              booking('b2', '#1002', 'FAILED', { error: 'PostEx does not deliver to Gilgit' }),
              booking('b3', '#1003', 'PENDING'),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'Orders':
        return {
          orders: {
            nodes: [packed('ord_1', '#1011'), packed('ord_2', '#1012')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [],
        };
      case 'OrdersBook':
        return {
          ordersBook: {
            bookings: [{ id: 'b4', orderName: '#1011' }],
            refused: [{ orderId: 'ord_2', message: 'is booked already' }],
            userErrors: [],
          },
        };
      case 'OrderFulfill':
        return {
          orderFulfill: {
            userErrors:
              variables.id === 'ord_2'
                ? [
                    {
                      field: ['id'],
                      code: 'INVALID',
                      message: 'Confirm the order with the customer before shipping it',
                    },
                  ]
                : [],
          },
        };
      case 'CourierLabels':
        return { courierLabels: { title: 'Labels: 1 parcel', html: '<html>labels</html>' } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Shipping in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('books the packed orders chosen with the default courier account', async () => {
    const core = shippingCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/shipping');

    await screen.findByText('#1011');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    await press('Book 2 with the courier');
    await screen.findByText('1 order sent to the courier. It is booked in a minute or so.');
    expect(screen.getByText('#1012 is booked already')).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'OrdersBook')?.variables).toEqual({
      ids: ['ord_1', 'ord_2'],
      accountId: 'acc_1',
    });
  });

  it('ships packed orders by hand at once, each by its tracking number, those refused named', async () => {
    const core = shippingCore([]);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/shipping');

    await screen.findByText('#1011');
    // No courier to book with: the orders are shipped by hand, by the courier the shop uses.
    expect(screen.getByText(/Choose packed orders to mark them shipped/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select all shown'));
    expect(screen.queryByRole('button', { name: 'Book 2 with the courier' })).toBeNull();
    await press('Mark 2 as shipped');
    expect(screen.getByRole('heading', { name: 'Mark 2 orders as shipped' })).toBeTruthy();

    type('Courier', 'TCS');
    type('Tracking number for #1011', ' 7712345678 ');
    await press('Mark 2 as shipped');
    await screen.findByText('1 order marked shipped.');
    expect(
      screen.getByText('#1012: Confirm the order with the customer before shipping it'),
    ).toBeTruthy();
    expect(
      core.sent.filter((each) => each.operation === 'OrderFulfill').map((each) => each.variables),
    ).toEqual([
      { id: 'ord_1', trackingInfo: { company: 'TCS', number: '7712345678', url: null } },
      { id: 'ord_2', trackingInfo: { company: 'TCS', number: null, url: null } },
    ]);
    // Each its own request, never taken for the other's repeat.
    const keys = core.fetcher.mock.calls
      .filter(([, init]) => String(init?.body).includes('OrderFulfill'))
      .map(([, init]) => (init?.headers as Record<string, string>)['idempotency-key']);
    expect(new Set(keys).size).toBe(2);
  });

  it("shows each booking's state, and prints the labels of those booked", async () => {
    const core = shippingCore();
    vi.stubGlobal('fetch', core.fetcher);
    const written: string[] = [];
    const tab = {
      document: {
        open: vi.fn(),
        write: (html: string) => written.push(html),
        close: vi.fn(),
        fonts: { ready: Promise.resolve() },
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderAdmin('/shop_1/shipping?tab=booked');

    await screen.findByText('CX-1001');
    expect(screen.getByText('On its way')).toBeTruthy();
    expect(screen.getByText('Not booked: PostEx does not deliver to Gilgit')).toBeTruthy();
    expect(screen.getByText('Booking with the courier…')).toBeTruthy();
    // Only a booked parcel has a label to print.
    expect(screen.queryByLabelText('Select #1002')).toBeNull();

    fireEvent.click(screen.getByLabelText('Select #1001'));
    await press('Print 1 label');
    await waitFor(() => expect(tab.print).toHaveBeenCalled());
    expect(written).toEqual(['<html>labels</html>']);
    expect(core.sent.find((each) => each.operation === 'CourierLabels')?.variables).toEqual({
      ids: ['b1'],
      language: 'BILINGUAL',
      paper: 'THERMAL_4X6',
    });
  });

  it("keeps the owner's bottom bar to five, the rest under More", async () => {
    vi.stubGlobal('fetch', shippingCore().fetcher);
    renderAdmin('/shop_1/more');

    const more = await screen.findByRole('navigation', { name: 'More' });
    expect(within(more).getByRole('link', { name: 'Products' })).toBeTruthy();
    expect(within(more).getByRole('link', { name: 'Customers' })).toBeTruthy();
    const bars = screen.getAllByRole('navigation', { name: 'Main' });
    const bottom = bars.at(-1)!;
    expect(
      within(bottom)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Home', 'Orders', 'Desk', 'Shipping', 'More']);
  });
});

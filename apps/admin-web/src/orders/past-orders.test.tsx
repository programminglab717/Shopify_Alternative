import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const PAST = {
  id: 'pord_1',
  name: '#S1042',
  customerId: 'cus_1',
  phone: '+923001234567',
  placedAt: '2025-03-20T09:00:00Z',
  cancelledAt: null,
  financialStatus: 'PARTIALLY_REFUNDED',
  fulfillmentStatus: 'FULFILLED',
  note: 'Leave with the guard',
  total: rupees('9250.00'),
  lines: [{ title: 'Lawn suit', variantTitle: 'M', quantity: 2, price: rupees('4500.00') }],
  shippingAddress: {
    name: 'Ayesha Khan',
    address1: 'House 12, Street 4',
    address2: null,
    city: 'Lahore',
    province: 'Punjab',
  },
};

/** A fake core with one order here, and `past` from the store the shop moved from. */
function core(past: (typeof PAST)[]) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Orders':
        return {
          orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          orderStageCounts: [],
        };
      case 'FreshOrders':
        return { orders: { nodes: [], pageInfo: { hasNextPage: false } } };
      case 'PastOrders':
        return { pastOrders: { nodes: past, pageInfo: { hasNextPage: false, endCursor: null } } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Orders from the old store (ADR-786)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('links to them from the orders while the shop has some, and shows each whole', async () => {
    vi.stubGlobal('fetch', core([PAST]).fetcher);
    renderAdmin('/shop_1/orders');
    fireEvent.click(await screen.findByRole('link', { name: 'From your old store' }));

    await screen.findByRole('heading', { name: 'Orders from your old store' });
    const card = (await screen.findByText('#S1042')).closest('li')!;
    expect(within(card).getByText('partially refunded · fulfilled')).toBeTruthy();
    expect(within(card).getByText('Rs 9,250')).toBeTruthy();
    expect(within(card).getByText('Lawn suit')).toBeTruthy();
    expect(within(card).getByText('House 12, Street 4, Lahore, Punjab')).toBeTruthy();
    expect(within(card).getByText('Leave with the guard')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Ayesha Khan' }).getAttribute('href')).toBe(
      '/shop_1/customers/cus_1',
    );
  });

  it('shows no link while the shop has none, and says so on the page', async () => {
    vi.stubGlobal('fetch', core([]).fetcher);
    renderAdmin('/shop_1/orders');
    await screen.findByRole('heading', { name: 'Orders' });
    expect(screen.queryByRole('link', { name: 'From your old store' })).toBeNull();
    cleanup();
    renderAdmin('/shop_1/orders/past');
    expect(await screen.findByText(/No orders from an old store/)).toBeTruthy();
  });
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const LAST = new Date(Date.now() - 86_400_000).toISOString();

function ayesha(phone: string) {
  return {
    id: 'cus_1',
    displayName: 'Ayesha Khan',
    name: 'Ayesha Khan',
    phone,
    otherPhones: [],
    email: null,
    note: '',
    tags: [],
    createdAt: LAST,
    numberOfOrders: 4,
    lastOrderAt: LAST,
    amountSpent: pkr('12400.00'),
    deliveryHistory: { delivered: 2, returned: 1, cancelled: 1, inProgress: 0, lost: 0 },
    blocklistEntry: null,
    whatsappMarketingConsent: { marketingState: 'SUBSCRIBED' },
    addresses: [{ formatted: ['House 12', 'Karachi'] }],
    orders: {
      nodes: [
        {
          id: 'ord_1',
          name: '#1001',
          createdAt: LAST,
          stage: 'DELIVERED',
          totalPrice: pkr('5599.00'),
        },
      ],
    },
  };
}

/** A fake core with one customer, whose number the role sees whole or masked. */
function customersCore(role: StaffRole) {
  const phone = role === 'owner' || role === 'manager' ? '+923001234567' : '0300 ••••567';
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Customers': {
        const { id, displayName, numberOfOrders, lastOrderAt, tags, amountSpent } = ayesha(phone);
        return {
          customers: {
            nodes: [
              {
                id,
                displayName,
                phone,
                numberOfOrders,
                lastOrderAt,
                tags,
                amountSpent,
                blocklistEntry: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      case 'Customer':
        return { shop: { timezone: 'Asia/Karachi' }, customer: ayesha(phone) };
      case 'CustomerPhoneReveal':
        return { customerPhoneReveal: { phone: '+923001234567', otherPhones: [], userErrors: [] } };
      case 'CustomerUpdate':
        return { customerUpdate: { customer: { id: 'cus_1' }, userErrors: [] } };
      case 'BlocklistAdd':
        return { blocklistAdd: { blocklistEntry: { id: 'blk_1' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Customers in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists customers, searched by their number', async () => {
    const core = customersCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/customers');

    await screen.findByText('Ayesha Khan');
    expect(screen.getByText('0300 1234567')).toBeTruthy();
    expect(screen.getByText('Rs 12,400')).toBeTruthy();
    type('Search customers', '4567');
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: '4567' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Customers').at(-1)?.variables,
      ).toMatchObject({ query: '4567' }),
    );
  });

  it("shows an agent a customer's record, and their number when they ask", async () => {
    const core = customersCore('confirmation_agent');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/customers/cus_1');

    await screen.findByText('Parcels they took: 2 of 3.');
    expect(screen.getByText('#1001')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();
    await press('Show number');
    const call = await screen.findByRole('link', { name: 'Call' });
    expect(call.getAttribute('href')).toBe('tel:+923001234567');
    // Agents change neither customers nor the blocklist.
    expect(screen.queryByText('Block this number')).toBeNull();
  });

  it("saves the shop's note and tags, and blocks a number for a reason", async () => {
    const core = customersCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/customers/cus_1');

    await screen.findByText('Block this number');
    type('Note', 'Prefers evening calls');
    type('Tags', 'vip, lahore');
    await press('Save');
    await screen.findByText('Saved.');
    expect(core.sent.find((each) => each.operation === 'CustomerUpdate')?.variables).toEqual({
      id: 'cus_1',
      input: { note: 'Prefers evening calls', tags: ['vip', 'lahore'] },
    });

    await press('Block this number');
    await press('refusing deliveries');
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'BlocklistAdd')?.variables).toEqual({
        input: { phone: '+923001234567', reason: 'REFUSED_DELIVERIES', note: null },
      }),
    );
  });
});

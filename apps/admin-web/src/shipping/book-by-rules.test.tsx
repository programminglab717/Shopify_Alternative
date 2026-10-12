import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const AGO = new Date(Date.now() - 3_600_000).toISOString();

function packed(id: string, name: string, city: string) {
  return {
    id,
    name,
    createdAt: AGO,
    stage: 'TO_BOOK',
    paymentMethod: 'CASH_ON_DELIVERY',
    overPlanLimit: false,
    totalPrice: pkr('5599.00'),
    customer: { displayName: 'Ayesha Khan' },
    shippingAddress: { name: 'Ayesha Khan', city },
    risk: { level: 'LOW' },
    lineItems: [{ quantity: 1 }],
  };
}

const ACCOUNTS = [
  { id: 'acc_1', name: 'PostEx', courierName: 'PostEx', isDefault: true },
  { id: 'acc_2', name: 'Karachi', courierName: 'Leopards', isDefault: false },
];

/** A shop with packed orders to Karachi and Multan, and courier rules or none. */
function core(rules: { id: string }[]) {
  return fakeCore('packer', (operation) => {
    switch (operation) {
      case 'Shipping':
        return {
          shop: { timezone: 'Asia/Karachi' },
          courierAccounts: ACCOUNTS,
          courierRules: rules,
          courierBookings: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'Orders':
        return {
          orders: {
            nodes: [packed('ord_1', '#1011', 'Karachi'), packed('ord_2', '#1012', 'Multan')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [],
        };
      case 'CourierAccountsFor':
        return {
          courierAccountsFor: [
            { orderId: 'ord_1', accountId: 'acc_2', ruleId: 'crl_1' },
            { orderId: 'ord_2', accountId: 'acc_1', ruleId: null },
          ],
        };
      case 'OrdersBook':
        return {
          ordersBook: {
            bookings: [
              { id: 'b1', orderName: '#1011' },
              { id: 'b2', orderName: '#1012' },
            ],
            refused: [],
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("Booking by the shop's courier rules (ADR-382)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says which courier each order goes with, and books by the rules unless one is chosen', async () => {
    const fake = core([{ id: 'crl_1' }]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping');

    const karachi = (await screen.findByText('#1011')).closest('li')!;
    expect(await within(karachi).findByText('Goes with Karachi (Leopards)')).toBeTruthy();
    const multan = screen.getByText('#1012').closest('li')!;
    expect(within(multan).getByText('Goes with PostEx')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select all shown'));
    const account = screen.getByLabelText<HTMLSelectElement>('Courier account');
    expect(account.value).toBe('');
    expect(
      within(account).getByRole('option', { name: "By the shop's courier rules" }),
    ).toBeTruthy();
    await press('Book 2 with the courier');
    await screen.findByText('2 orders sent to the courier. Each is booked in a minute or so.');
    expect(fake.sent.find((each) => each.operation === 'OrdersBook')?.variables).toEqual({
      ids: ['ord_1', 'ord_2'],
      accountId: null,
    });

    // An account chosen books them all with it, and the rules' choices are no longer said.
    fireEvent.click(screen.getByLabelText('Select all shown'));
    fireEvent.change(screen.getByLabelText('Courier account'), { target: { value: 'acc_1' } });
    expect(screen.queryByText(/^Goes with/)).toBeNull();
  });

  it('books with the default as before where the shop has no rules', async () => {
    const fake = core([]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping');

    await screen.findByText('#1011');
    expect(screen.queryByText(/^Goes with/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Select all shown'));
    const account = screen.getByLabelText<HTMLSelectElement>('Courier account');
    expect(account.value).toBe('acc_1');
    expect(
      within(account).queryByRole('option', { name: "By the shop's courier rules" }),
    ).toBeNull();
    expect(fake.sent.some((each) => each.operation === 'CourierAccountsFor')).toBe(false);
  });
});

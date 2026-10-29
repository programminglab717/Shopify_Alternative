import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const LAST = new Date(Date.now() - 86_400_000).toISOString();

const CUSTOMER = {
  id: 'cus_1',
  displayName: 'Ayesha Khan',
  name: 'Ayesha Khan',
  phone: '+923001234567',
  otherPhones: [],
  email: null,
  note: '',
  tags: [],
  createdAt: LAST,
  numberOfOrders: 2,
  lastOrderAt: LAST,
  amountSpent: pkr('5500.00'),
  deliveryHistory: { delivered: 1, returned: 0, cancelled: 0, inProgress: 1, lost: 0 },
  blocklistEntry: null,
  whatsappMarketingConsent: { marketingState: 'SUBSCRIBED' },
  smsMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' },
  emailMarketingConsent: { marketingState: 'UNSUBSCRIBED' },
  erasureScheduledAt: null,
  addresses: [],
  savedAddresses: [],
  orders: { nodes: [] },
};

function core(role: StaffRole) {
  let limit: string | null = null;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Customer':
        return { shop: { timezone: 'Asia/Karachi' }, customer: CUSTOMER };
      case 'CustomerStoreCredit':
      case 'CustomerStoreCreditLedger':
        return { customer: { id: variables.id, storeCreditAccounts: { nodes: [] } } };
      case 'CustomerCredit':
        return {
          customerCredit: {
            creditLimit: limit === null ? null : { amount: `${limit}.00` },
            owed: { amount: '36000.00' },
            overdue: { amount: '12000.00' },
          },
        };
      case 'CustomerCreditLimitSet': {
        const given = variables.creditLimit as string | null;
        if (given === '-5') {
          return {
            customerCreditLimitSet: {
              credit: null,
              userErrors: [
                {
                  field: ['creditLimit'],
                  code: 'INVALID',
                  message: 'Credit limit must be an amount of zero or more, like 2499 or 2499.50',
                },
              ],
            },
          };
        }
        limit = given === null ? null : given.replace(/,/g, '');
        return {
          customerCreditLimitSet: {
            credit: { creditLimit: limit === null ? null : { amount: `${limit}.00` } },
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A wholesale customer's credit on payment terms (ADR-907)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what they owe and sets their credit limit, for owners and managers', async () => {
    signedIn();
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/cus_1');
    expect(await screen.findByText('Credit on payment terms')).toBeTruthy();
    expect(await screen.findByText('Owed on terms')).toBeTruthy();
    expect(screen.getByText(/36,000/)).toBeTruthy();
    expect(screen.getByText(/12,000/).className).toContain('text-danger');

    type('Credit limit (Rs)', '-5');
    await press('Save credit limit');
    await screen.findByText(/must be an amount of zero or more/);
    type('Credit limit (Rs)', '200,000');
    await press('Save credit limit');
    await screen.findByText('Saved.');
    expect(
      fake.sent.filter((each) => each.operation === 'CustomerCreditLimitSet').at(-1)?.variables,
    ).toEqual({ customerId: 'cus_1', creditLimit: '200,000' });
    await waitFor(() =>
      expect((screen.getByLabelText('Credit limit (Rs)') as HTMLInputElement).value).toBe('200000'),
    );
    // Emptied, no limit.
    type('Credit limit (Rs)', '');
    await press('Save credit limit');
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'CustomerCreditLimitSet').at(-1)?.variables,
      ).toEqual({ customerId: 'cus_1', creditLimit: null }),
    );
  });

  it('only shows the limit to accountants, and nothing to those who see no orders', async () => {
    signedIn();
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/customers/cus_1');
    expect(await screen.findByText('No credit limit.')).toBeTruthy();
    expect(screen.queryByLabelText('Credit limit (Rs)')).toBeNull();
  });
});

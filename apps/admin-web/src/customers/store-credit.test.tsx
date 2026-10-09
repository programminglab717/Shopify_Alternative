import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

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
  addresses: [],
  orders: { nodes: [] },
};

const LINES = [
  {
    id: 'sct_2',
    kind: 'DEBIT',
    event: 'ORDER_PAYMENT',
    amount: pkr('-500.00'),
    balanceAfterTransaction: pkr('1500.00'),
    remainingAmount: null,
    expiresAt: null,
    createdAt: LAST,
    note: '',
    orderId: 'ord_2',
  },
  {
    id: 'sct_1',
    kind: 'CREDIT',
    event: 'ORDER_REFUND',
    amount: pkr('2000.00'),
    balanceAfterTransaction: pkr('2000.00'),
    remainingAmount: pkr('1500.00'),
    expiresAt: LATER,
    createdAt: LAST,
    note: 'Torn dupatta',
    orderId: 'ord_1',
  },
];

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Customer':
        return { shop: { timezone: 'Asia/Karachi' }, customer: CUSTOMER };
      case 'CustomerStoreCredit':
      case 'CustomerStoreCreditLedger':
        return {
          customer: {
            id: variables.id,
            storeCreditAccounts: {
              nodes: [
                {
                  id: 'sca_1',
                  balance: pkr('1500.00'),
                  ...(operation === 'CustomerStoreCreditLedger' && {
                    transactions: { nodes: LINES },
                  }),
                },
              ],
            },
          },
        };
      case 'StoreCreditCredit':
        return {
          storeCreditAccountCredit: {
            storeCreditAccountTransaction: { id: 'sct_3' },
            userErrors: [],
          },
        };
      case 'StoreCreditDebit':
        return {
          storeCreditAccountDebit: {
            storeCreditAccountTransaction: { id: 'sct_4' },
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("A customer's store credit", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what it holds and what it went on, gives credit that expires, and takes some back', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/cus_1');

    const section = await screen.findByRole('region', { name: 'Store credit' });
    expect(await within(section).findByText('Rs 1,500')).toBeTruthy();
    const ledger = within(section).getByRole('list', { name: 'What their credit went on' });
    const [paid, refunded] = within(ledger).getAllByRole('listitem');
    expect(paid!.textContent).toContain('Paid for an order');
    expect(paid!.textContent).toContain('-Rs 500');
    expect(within(paid!).getByRole('link', { name: 'Its order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_2',
    );
    expect(refunded!.textContent).toContain('Refunded as credit');
    expect(refunded!.textContent).toContain('+Rs 2,000');
    expect(refunded!.textContent).toContain('Torn dupatta');
    expect(refunded!.textContent).toMatch(/expires /);

    fireEvent.click(within(section).getByRole('button', { name: 'Give credit' }));
    type('Amount to give', '1000');
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2026-12-31' } });
    type('Reason', 'Sorry for the late parcel');
    fireEvent.click(screen.getByRole('button', { name: 'Give the credit' }));
    expect(await screen.findByText('Rs 1,000 of store credit given.')).toBeTruthy();
    expect(sentOf(fake, 'StoreCreditCredit')).toEqual([
      {
        id: 'cus_1',
        creditInput: {
          creditAmount: pkr('1000'),
          // The end of the day in Pakistan, whatever the phone's time zone.
          expiresAt: '2026-12-31T18:59:59.000Z',
          note: 'Sorry for the late parcel',
        },
      },
    ]);

    fireEvent.click(within(section).getByRole('button', { name: 'Take credit back' }));
    type('Amount to take back, up to Rs 1,500', '2000');
    expect(screen.getByText('That is more than they have.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Take it back' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    type('Amount to take back, up to Rs 1,500', '500');
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(await screen.findByText('Rs 500 of store credit taken back.')).toBeTruthy();
    expect(sentOf(fake, 'StoreCreditDebit')).toEqual([
      { id: 'cus_1', debitInput: { debitAmount: pkr('500') } },
    ]);
  });

  it('shows an agent what it holds alone, and a marketer none of it', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/cus_1');
    const section = await screen.findByRole('region', { name: 'Store credit' });
    expect(await within(section).findByText('Rs 1,500')).toBeTruthy();
    expect(within(section).queryByRole('list')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
    expect(sentOf(fake, 'CustomerStoreCreditLedger')).toEqual([]);
    cleanup();

    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/customers/cus_1');
    expect(await screen.findByRole('heading', { name: 'Ayesha Khan' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Store credit' })).toBeNull());
  });
});

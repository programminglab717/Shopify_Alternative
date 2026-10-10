import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';
import { refundable } from './money';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });
const STORAGE = 'http://localhost:4000/storage/shops/shop_1/files/f9/receipt.jpg';

function order(paid: string, extra: Record<string, unknown> = {}) {
  return {
    shop: { timezone: 'Asia/Karachi' },
    paymentSessions: [],
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage: 'DELIVERED',
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: paid === '0' ? 'PENDING' : 'PAID',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      location: { id: 'loc_1', name: 'Main location' },
      note: null,
      tags: [],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [],
      subtotalPrice: rupees('7500'),
      totalShippingPrice: rupees('200'),
      totalDiscounts: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('7700'),
      amountPaid: rupees(paid),
      codAmount: rupees('0'),
      customer: null,
      shippingAddress: { name: 'Ayesha', phone: '+923001234567', city: 'Lahore', formatted: [] },
      risk: null,
      assignee: null,
      amountRefunded: rupees('0'),
      advanceDue: rupees('0'),
      transferReceipts: [],
      customerLink: null,
      refunds: [],
      fulfillments: [],
      returns: [],
      events: { nodes: [] },
      ...extra,
    },
  };
}

function core(role: StaffRole, answer: ReturnType<typeof order>) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return answer;
      case 'StagedUploadsCreate':
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: `${STORAGE}?expires=1&signature=s`,
                httpMethod: 'PUT',
                resourceUrl: STORAGE,
                parameters: [{ name: 'content-type', value: 'image/jpeg' }],
              },
            ],
            userErrors: [],
          },
        };
      case 'OrderRefund':
        return { orderRefund: { refund: { id: 'rfd_2' }, userErrors: [] } };
      case 'OrderMarkAsPaid':
        return { orderMarkAsPaid: { userErrors: [] } };
      case 'CustomerStoreCredit':
        return {
          customer: {
            id: 'cus_1',
            storeCreditAccounts: { nodes: [{ id: 'sca_1', balance: rupees('1500.00') }] },
          },
        };
      case 'OrderPayWithStoreCredit':
        return { orderPayWithStoreCredit: { order: { id: 'ord_7' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const EARLIER = {
  amountRefunded: rupees('500'),
  refunds: [
    {
      id: 'rfd_1',
      amount: rupees('500'),
      method: 'CASH',
      note: 'Late delivery',
      reference: null,
      createdAt: LATER,
      receipt: { url: 'https://files.example/receipt-1.jpg', mimeType: 'image/jpeg' },
    },
  ],
};

describe("An order's money, on its page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('refunds by transfer, at most what is left, with its reference and receipt', async () => {
    const fake = core('owner', order('7700', EARLIER));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    expect(within(money).getByText('-Rs 500')).toBeTruthy();
    expect(within(money).getByText(/Late delivery/)).toBeTruthy();
    expect(within(money).getByRole('link', { name: 'See the receipt' }).getAttribute('href')).toBe(
      'https://files.example/receipt-1.jpg',
    );

    fireEvent.click(within(money).getByRole('button', { name: 'Refund' }));
    const amount = within(money).getByLabelText('Amount, at most Rs 7,200') as HTMLInputElement;
    expect(amount.value).toBe('7200');
    fireEvent.change(amount, { target: { value: '8000' } });
    expect(within(money).getByText('More than was paid and not refunded yet.')).toBeTruthy();
    fireEvent.change(amount, { target: { value: '1500' } });
    type('Reference', 'IBFT-88123');
    type('Why', 'One suit came back');
    await act(async () =>
      fireEvent.change(within(money).getByLabelText('Receipt'), {
        target: { files: [new File([new Uint8Array(8)], 'ibft.jpg', { type: 'image/jpeg' })] },
      }),
    );
    fireEvent.click(within(money).getByRole('button', { name: 'Record the refund' }));

    await within(money).findByText('Rs 1,500 refunded.');
    expect(fake.uploads).toEqual([
      { url: `${STORAGE}?expires=1&signature=s`, type: 'image/jpeg', size: 8 },
    ]);
    expect(fake.sent.find((each) => each.operation === 'OrderRefund')?.variables).toEqual({
      id: 'ord_7',
      input: {
        amount: '1500',
        method: 'BANK_TRANSFER',
        reference: 'IBFT-88123',
        note: 'One suit came back',
        receipt: STORAGE,
      },
    });
  });

  it('refunds as store credit, with no reference or receipt to give', async () => {
    const fake = core('manager', order('7700'));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    fireEvent.click(within(money).getByRole('button', { name: 'Refund' }));
    fireEvent.change(within(money).getByLabelText('How'), { target: { value: 'STORE_CREDIT' } });
    expect(within(money).queryByLabelText('Reference')).toBeNull();
    expect(within(money).queryByLabelText('Receipt')).toBeNull();
    fireEvent.change(within(money).getByLabelText(/^Amount/), { target: { value: '2000' } });
    fireEvent.click(within(money).getByRole('button', { name: 'Record the refund' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'OrderRefund')?.variables).toEqual({
        id: 'ord_7',
        input: { amount: '2000', method: 'STORE_CREDIT' },
      }),
    );
  });

  it('marks an order paid after saying how much it records', async () => {
    const fake = core('owner', order('0'));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    // Nothing paid, nothing to give back.
    expect(within(money).queryByRole('button', { name: 'Refund' })).toBeNull();
    fireEvent.click(within(money).getByRole('button', { name: 'Mark as paid' }));
    expect(within(money).getByText(/records Rs 7,700 received/)).toBeTruthy();
    fireEvent.click(within(money).getByRole('button', { name: 'Mark as paid' }));
    await within(money).findByText('Marked as paid.');
    expect(fake.sent.find((each) => each.operation === 'OrderMarkAsPaid')?.variables).toEqual({
      id: 'ord_7',
    });
  });

  it('shows what was paid to those who only see it, and works out what is left to give back', async () => {
    const fake = core(
      'packer',
      order('7700', {
        amountRefunded: rupees('600'),
        refunds: [
          ...EARLIER.refunds,
          {
            id: 'rfd_3',
            amount: rupees('100'),
            method: 'STORE_CREDIT',
            note: '',
            reference: 'sct_01m4fya0kqe1r9cbqczdtax8w7',
            createdAt: LATER,
            receipt: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    expect(within(money).getByText('-Rs 600')).toBeTruthy();
    expect(within(money).getByText('Store credit')).toBeTruthy();
    expect(within(money).queryByText(/sct_/)).toBeNull();
    expect(within(money).queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(refundable({ amountPaid: rupees('7700'), amountRefunded: rupees('500.50') })).toBe(
      '7199.50',
    );
    expect(refundable({ amountPaid: rupees('100'), amountRefunded: rupees('100') })).toBe('0');
  });
  it("pays an order not yet shipped with its customer's store credit, as much as it covers", async () => {
    const customer = { id: 'cus_1', displayName: 'Ayesha Khan', numberOfOrders: 2 };
    const fake = core('manager', order('0', { stage: 'TO_PACK', customer }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Pay with store credit (Rs 1,500)' }),
    );
    expect(
      screen.getByText(/They have Rs 1,500 of store credit; the order owes Rs 7,700\./),
    ).toBeTruthy();
    const amount = screen.getByLabelText('Amount, at most Rs 1,500') as HTMLInputElement;
    expect(amount.value).toBe('1500');
    fireEvent.click(screen.getByRole('button', { name: 'Pay with store credit' }));
    expect(await screen.findByText('Rs 1,500 paid with store credit.')).toBeTruthy();
    expect(
      fake.sent
        .filter((each) => each.operation === 'OrderPayWithStoreCredit')
        .map((each) => each.variables),
    ).toEqual([{ id: 'ord_7', amount: '1500' }]);
    cleanup();

    // Once a parcel is on its way, credit no longer pays it.
    vi.stubGlobal('fetch', core('owner', order('0', { stage: 'IN_TRANSIT', customer })).fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    expect(await screen.findByRole('button', { name: 'Mark as paid' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay with store credit/ })).toBeNull();
  });
});

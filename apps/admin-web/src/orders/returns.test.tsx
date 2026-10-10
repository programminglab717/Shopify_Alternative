import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDetail } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';
import { returnable } from './returns';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const line = (id: string, title: string, variantTitle: string, quantity: number) => ({
  id,
  productId: `prod_${id}`,
  variantId: `var_${id}`,
  title,
  variantTitle,
  sku: null,
  quantity,
  unitPrice: rupees('2500'),
  totalPrice: rupees(String(2500 * quantity)),
});

const parcel = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'ful_1',
  status,
  shippedAt: LATER,
  deliveredAt: status === 'DELIVERED' ? LATER : null,
  returningAt: null,
  returnedAt: null,
  lostAt: null,
  trackingInfo: { company: 'Leopards', number: 'LE4402917', url: null },
  fulfillmentLineItems: [
    { quantity: 2, lineItem: { id: 'li_1', title: 'Lawn suit', variantTitle: 'M' } },
    { quantity: 1, lineItem: { id: 'li_2', title: 'Dupatta', variantTitle: 'Default Title' } },
  ],
  events: { nodes: [] },
  claim: null,
  ...extra,
});

const back = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'ret_1',
  name: '#1007-R1',
  status,
  createdAt: LATER,
  closedAt: null,
  note: '',
  trackingInfo: { company: 'TCS', number: '779000111' },
  exchangeOrder: null,
  returnLineItems: [
    {
      quantity: 2,
      restockedQuantity: null,
      returnReason: 'SIZE_TOO_SMALL',
      lineItem: { id: 'li_1' },
    },
  ],
  ...extra,
});

function order(fulfillments: unknown[], returns: unknown[]) {
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
      financialStatus: 'PAID',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      note: null,
      tags: [],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [line('li_1', 'Lawn suit', 'M', 2), line('li_2', 'Dupatta', 'Default Title', 1)],
      subtotalPrice: rupees('7500'),
      totalShippingPrice: rupees('200'),
      totalDiscounts: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('7700'),
      amountPaid: rupees('7700'),
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
      fulfillments,
      returns,
      events: { nodes: [] },
    },
  };
}

function core(role: StaffRole, fulfillments: unknown[], returns: unknown[]) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return order(fulfillments, returns);
      case 'ProductVariants':
        return {
          product: {
            id: 'prod_li_1',
            variants: [
              { id: 'var_li_1', title: 'M', availableForSale: true, inventoryQuantity: 4 },
              { id: 'var_l', title: 'L', availableForSale: true, inventoryQuantity: 3 },
              { id: 'var_xl', title: 'XL', availableForSale: false, inventoryQuantity: 0 },
            ],
          },
        };
      case 'ReturnCreate':
        return {
          returnCreate: {
            return: {
              id: 'ret_2',
              name: '#1007-R2',
              exchangeOrder: { id: 'ord_9', name: '#1019' },
            },
            userErrors: [],
          },
        };
      case 'ReturnReceive':
        return { returnReceive: { userErrors: [] } };
      case 'ReturnCancel':
        return { returnCancel: { userErrors: [] } };
      case 'ParcelClaimCreate':
        return { fulfillmentClaimCreate: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("An order's customer returns, on its page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('records a return of what was delivered, with another size sent in exchange', async () => {
    const fake = core('manager', [parcel('DELIVERED')], []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const section = await screen.findByRole('region', { name: 'Returns' });
    expect(within(section).getByText('Nothing returned yet.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Record a return' }));
    const suits = within(section).getByLabelText('How many come back, of 2');
    fireEvent.change(suits, { target: { value: '3' } });
    expect(within(section).getByText(/no more than was delivered/)).toBeTruthy();
    fireEvent.change(suits, { target: { value: '1' } });
    // The size coming back is not offered for the exchange; one out of stock says so.
    const exchange = (await within(section).findByLabelText(
      'Send in exchange',
    )) as HTMLSelectElement;
    await within(section).findByText('L (3 in stock)');
    expect(within(section).queryByText('M (4 in stock)')).toBeNull();
    expect(within(section).getByText('XL (out of stock)')).toBeTruthy();
    fireEvent.change(exchange, { target: { value: 'var_l' } });
    type("Exchange's delivery charge", '200');
    type('Courier bringing it back', 'TCS');
    type('Tracking number', '779000222');
    fireEvent.click(within(section).getByRole('button', { name: 'Record the return' }));

    await screen.findByText('#1007-R2 recorded, and #1019 made to send in exchange.');
    expect(fake.sent.find((each) => each.operation === 'ReturnCreate')?.variables).toEqual({
      input: {
        orderId: 'ord_7',
        returnLineItems: [{ lineItemId: 'li_1', quantity: 1, returnReason: 'SIZE_TOO_SMALL' }],
        exchangeLineItems: [{ variantId: 'var_l', quantity: 1 }],
        exchangeShippingPrice: '200',
        trackingInfo: { company: 'TCS', number: '779000222' },
      },
    });
  });

  it('checks a return in with what came back damaged written off, or cancels it', async () => {
    const fake = core('packer', [parcel('DELIVERED')], [back('OPEN')]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const section = await screen.findByRole('region', { name: 'Returns' });
    expect(within(section).getByText('On its way back')).toBeTruthy();
    expect(within(section).getByText('2 × Lawn suit (M)')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Check it in' }));
    fireEvent.change(within(section).getByLabelText('Back in stock, of 2'), {
      target: { value: '1' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Check in' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ReturnReceive')?.variables).toEqual({
        id: 'ret_1',
        restock: [{ lineItemId: 'li_1', quantity: 1 }],
      }),
    );

    fireEvent.click(
      await within(section).findByRole('button', { name: 'Customer kept it: cancel the return' }),
    );
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ReturnCancel')?.variables).toEqual({
        id: 'ret_1',
      }),
    );
  });

  it('claims a parcel back damaged from its courier, for those who claim', async () => {
    const fake = core('accountant', [parcel('RETURNED')], []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    fireEvent.click(
      within(parcels).getByRole('button', { name: 'Claim the damage from the courier' }),
    );
    type('Note', 'LCS-CLM-77');
    fireEvent.click(within(parcels).getByRole('button', { name: 'File the claim' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ParcelClaimCreate')?.variables).toEqual({
        id: 'ful_1',
        amount: null,
        note: 'LCS-CLM-77',
      }),
    );
  });

  it('works out what can still come back: delivered, less what returns bring back', () => {
    const fulfillments = [
      parcel('DELIVERED'),
      parcel('IN_TRANSIT', { id: 'ful_2' }),
    ] as unknown as OrderDetail['fulfillments'];
    const returns = [
      back('CLOSED', {
        returnLineItems: [
          { quantity: 1, restockedQuantity: 1, returnReason: 'UNWANTED', lineItem: { id: 'li_1' } },
        ],
      }),
      back('CANCELLED', { id: 'ret_2' }),
    ] as unknown as OrderDetail['returns'];
    expect(Object.fromEntries(returnable({ fulfillments, returns }))).toEqual({
      li_1: 1,
      li_2: 1,
    });
  });
});

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDetail } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';
import { splittable } from './merge-split';

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

function order(extra: Record<string, unknown> = {}) {
  return {
    shop: { timezone: 'Asia/Karachi' },
    paymentSessions: [],
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage: 'TO_PACK',
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      location: { id: 'loc_1', name: 'Main location' },
      note: '',
      tags: [],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [line('li_1', 'Lawn suit', 'M', 2), line('li_2', 'Dupatta', 'Default Title', 1)],
      subtotalPrice: rupees('7500'),
      totalShippingPrice: rupees('200'),
      totalDiscounts: rupees('0'),
      transferDiscount: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('7700'),
      amountPaid: rupees('0'),
      codAmount: rupees('7700'),
      customer: { id: 'cus_1', displayName: 'Ayesha Khan', numberOfOrders: 4 },
      shippingAddress: { name: 'Ayesha', phone: '+923001234567', city: 'Lahore', formatted: [] },
      risk: null,
      assignee: null,
      mergedInto: null,
      splitFrom: null,
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

const other = (id: string, name: string, stage: string, paymentMethod = 'CASH_ON_DELIVERY') => ({
  id,
  name,
  createdAt: LATER,
  stage,
  status: stage === 'DELIVERED' ? 'CLOSED' : 'OPEN',
  paymentMethod,
  totalPrice: rupees('3200'),
  lineItems: [{ id: `li_${id}`, title: 'Khussa', quantity: 1 }],
});

function core(role: StaffRole, answer = order(), others = [other('ord_3', '#1003', 'TO_PACK')]) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return answer;
      case 'OrderMergeCandidates':
        return {
          order: {
            id: 'ord_7',
            customer: {
              id: 'cus_1',
              orders: {
                nodes: [
                  other('ord_7', '#1007', 'TO_PACK'),
                  ...others,
                  other('ord_1', '#1001', 'DELIVERED'),
                  other('ord_4', '#1004', 'AWAITING_PAYMENT', 'BANK_TRANSFER'),
                ],
              },
            },
          },
        };
      case 'OrderMerge':
        return { orderMerge: { order: { id: 'ord_3', name: '#1003' }, userErrors: [] } };
      case 'OrderSplit':
        return { orderSplit: { splitOrder: { id: 'ord_17', name: '#1017' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe('Merging and splitting an order, on its page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("merges an order placed twice into the customer's other waiting order, and opens it", async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Merge into another order' }));
    // Only the other order waiting to be packed and paid the same way is offered.
    const choice = await within(items).findByRole('radio');
    expect(within(items).getAllByRole('radio')).toHaveLength(1);
    expect(within(items).getByText(/^#1003/)).toBeTruthy();
    expect(within(items).getByText('1 × Khussa')).toBeTruthy();
    fireEvent.click(choice);
    expect(within(items).getByText(/#1003 takes the items of #1007/)).toBeTruthy();
    fireEvent.click(within(items).getByRole('button', { name: 'Merge into #1003' }));

    await waitFor(() =>
      expect(sentOf(fake, 'OrderMerge')).toEqual({ id: 'ord_7', intoId: 'ord_3' }),
    );
    await waitFor(() => expect(sentOf(fake, 'Order')).toEqual({ id: 'ord_3' }));
  });

  it('says when the customer has no other order to merge into', async () => {
    vi.stubGlobal('fetch', core('manager', order(), []).fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Merge into another order' }));
    expect(await within(items).findByText(/has no other order waiting/)).toBeTruthy();
    expect(within(items).queryByRole('button', { name: /^Merge into #/ })).toBeNull();
    fireEvent.click(within(items).getByRole('button', { name: 'Cancel' }));
    expect(within(items).getByRole('button', { name: 'Send part apart' })).toBeTruthy();
  });

  it('sends units apart as an order of their own with its delivery charge, never all of them', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Send part apart' }));
    const more = (title: string) =>
      fireEvent.click(within(items).getByRole('button', { name: `One more ${title} sent apart` }));
    more('Lawn suit · M');
    more('Lawn suit · M');
    expect(
      (
        within(items).getByRole('button', {
          name: 'One more Lawn suit · M sent apart',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    more('Dupatta');
    expect(within(items).getByText(/Something has to stay on this order/)).toBeTruthy();
    expect(
      (within(items).getByRole('button', { name: 'Send 3 apart' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(items).getByRole('button', { name: 'One fewer Dupatta sent apart' }));
    type('Delivery charge of the part sent apart', '200');
    fireEvent.click(within(items).getByRole('button', { name: 'Send 2 apart' }));

    await within(items).findByText('Sent apart as #1017.');
    expect(within(items).getByRole('link', { name: 'Open #1017' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_17',
    );
    expect(sentOf(fake, 'OrderSplit')).toEqual({
      id: 'ord_7',
      input: { lineItems: [{ lineItemId: 'li_1', quantity: 2 }], shippingPrice: '200' },
    });
  });

  it('links an order merged away to the order its items went to, with nothing left to change', async () => {
    vi.stubGlobal(
      'fetch',
      core(
        'owner',
        order({
          stage: 'CANCELLED',
          status: 'CANCELLED',
          cancelReason: 'MERGED',
          mergedInto: { id: 'ord_3', name: '#1003' },
        }),
      ).fetcher,
    );
    renderAdmin('/shop_1/orders/ord_7');

    expect((await screen.findByRole('link', { name: '#1003' })).getAttribute('href')).toBe(
      '/shop_1/orders/ord_3',
    );
    expect(screen.getByText('Cancelled: Merged into another order')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge into another order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send part apart' })).toBeNull();

    const waiting = order().order as unknown as OrderDetail;
    expect(splittable(waiting)).toBe(true);
    expect(splittable({ ...waiting, paymentMethod: 'BANK_TRANSFER' })).toBe(false);
    expect(splittable({ ...waiting, amountPaid: rupees('500') })).toBe(false);
    expect(splittable({ ...waiting, lineItems: [line('li_1', 'Lawn suit', 'M', 1)] })).toBe(false);
  });
});

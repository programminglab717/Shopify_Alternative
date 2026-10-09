import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const line = (id: string, title: string, variantTitle: string, quantity: number) => ({
  id,
  title,
  variantTitle,
  sku: null,
  quantity,
  unitPrice: rupees('2500'),
  totalPrice: rupees(String(2500 * quantity)),
});

const step = (id: string, status: string, message: string | null, hoursAgo: number) => ({
  id,
  status,
  message,
  happenedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
});

function order(fulfillments: unknown[]) {
  return {
    shop: { timezone: 'Asia/Karachi' },
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage: 'IN_TRANSIT',
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
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
      amountPaid: rupees('0'),
      codAmount: rupees('7700'),
      customer: null,
      shippingAddress: {
        name: 'Ayesha',
        phone: '+923001234567',
        city: 'Lahore',
        formatted: ['House 4', 'Lahore'],
      },
      risk: null,
      assignee: null,
      fulfillments,
      events: { nodes: [] },
    },
  };
}

const parcel = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'ful_1',
  status,
  shippedAt: LATER,
  deliveredAt: null,
  returningAt: null,
  returnedAt: null,
  lostAt: null,
  trackingInfo: {
    company: 'Leopards',
    number: 'LE4402917',
    url: 'https://leopardscourier.com/track?cn=LE4402917',
  },
  fulfillmentLineItems: [
    { quantity: 2, lineItem: { id: 'li_1', title: 'Lawn suit', variantTitle: 'M' } },
    { quantity: 1, lineItem: { id: 'li_2', title: 'Dupatta', variantTitle: 'Default Title' } },
  ],
  events: {
    nodes: [
      step('evt_4', 'OUT_FOR_DELIVERY', 'Rider: Imran', 1),
      step('evt_3', 'IN_TRANSIT', 'Lahore hub', 20),
      step('evt_2', 'IN_TRANSIT', 'Karachi hub', 40),
      step('evt_1', 'CONFIRMED', null, 50),
    ],
  },
  ...extra,
});

function core(role: StaffRole, fulfillments: unknown[]) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return order(fulfillments);
      case 'ParcelMarkDelivered':
        return { fulfillmentMarkDelivered: { userErrors: [] } };
      case 'ParcelMarkReturning':
        return { fulfillmentMarkReturning: { userErrors: [] } };
      case 'ParcelEventCreate':
        return { fulfillmentEventCreate: { userErrors: [] } };
      case 'ParcelReceive':
        return { fulfillmentReceiveReturn: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("An order's parcels, on its page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a parcel on its way with its latest steps, and marks it delivered or refused', async () => {
    const fake = core('packer', [parcel('IN_TRANSIT')]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    const tracking = within(parcels).getByRole('link', { name: 'Leopards · LE4402917' });
    expect(tracking.getAttribute('href')).toBe('https://leopardscourier.com/track?cn=LE4402917');
    expect(within(parcels).getByText('2 × Lawn suit (M)')).toBeTruthy();
    expect(within(parcels).getByText('1 × Dupatta')).toBeTruthy();
    // The latest three steps first; the booking only once all are asked for.
    expect(within(parcels).getByText('Rider: Imran')).toBeTruthy();
    expect(within(parcels).queryByText('Booked with the courier')).toBeNull();
    fireEvent.click(within(parcels).getByRole('button', { name: 'All 4 steps' }));
    expect(within(parcels).getByText('Booked with the courier')).toBeTruthy();

    fireEvent.click(within(parcels).getByRole('button', { name: 'Delivered' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ParcelMarkDelivered')?.variables).toEqual(
        { id: 'ful_1' },
      ),
    );
    fireEvent.click(
      await within(parcels).findByRole('button', { name: 'Refused or not delivered' }),
    );
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ParcelMarkReturning')?.variables).toEqual(
        { id: 'ful_1' },
      ),
    );
  });

  it('adds a step told of a courier Hatti does not follow', async () => {
    const fake = core('confirmation_agent', [parcel('IN_TRANSIT')]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Add a step' }));
    fireEvent.change(screen.getByLabelText('What happened'), {
      target: { value: 'ATTEMPTED_DELIVERY' },
    });
    type("Courier's words", 'Customer not at home');
    fireEvent.click(screen.getByRole('button', { name: 'Add the step' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ParcelEventCreate')?.variables).toEqual({
        fulfillmentEvent: {
          fulfillmentId: 'ful_1',
          status: 'ATTEMPTED_DELIVERY',
          message: 'Customer not at home',
        },
      }),
    );
  });

  it('checks a parcel back in with what came back damaged written off', async () => {
    const fake = core('manager', [parcel('RETURNING', { returningAt: LATER })]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Check it in' }));
    const suits = screen.getByLabelText('Back in stock, of 2') as HTMLInputElement;
    expect(suits.value).toBe('2');
    fireEvent.change(suits, { target: { value: '1' } });
    expect(screen.getByText('1 item will be written off as damaged.')).toBeTruthy();
    fireEvent.change(suits, { target: { value: '3' } });
    expect(screen.getByText(/no more than the parcel had/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(suits, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ParcelReceive')?.variables).toEqual({
        id: 'ful_1',
        restock: [
          { lineItemId: 'li_1', quantity: 1 },
          { lineItemId: 'li_2', quantity: 1 },
        ],
      }),
    );
  });

  it('leaves parcels as they are for those who only view orders', async () => {
    const fake = core('accountant', [parcel('IN_TRANSIT')]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    // Its state in the order stages' words, and two steps of its way in the courier's.
    expect(within(parcels).getByText('In transit')).toBeTruthy();
    expect(within(parcels).getAllByText('On its way')).toHaveLength(2);
    expect(within(parcels).queryByRole('button', { name: 'Delivered' })).toBeNull();
    expect(within(parcels).queryByRole('button', { name: 'Courier lost it' })).toBeNull();
  });
});

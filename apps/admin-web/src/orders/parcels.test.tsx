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

function order(fulfillments: unknown[], stage = 'IN_TRANSIT') {
  return {
    shop: { timezone: 'Asia/Karachi' },
    paymentSessions: [],
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage,
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      location: { id: 'loc_1', name: 'Main location' },
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
      amountRefunded: rupees('0'),
      advanceDue: rupees('0'),
      transferReceipts: [],
      customerLink: null,
      refunds: [],
      fulfillments,
      returns: [],
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
  claim: null,
  ...extra,
});

function core(role: StaffRole, fulfillments: unknown[], stage?: string) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Order':
        return order(fulfillments, stage);
      case 'OrderFulfill': {
        const number = (variables.trackingInfo as { number: string | null }).number;
        const userErrors =
          number === '77 12'
            ? [
                {
                  field: ['input', 'trackingInfo', 'number'],
                  code: 'INVALID',
                  message: 'is too short',
                },
              ]
            : [];
        return { orderFulfill: { userErrors } };
      }
      case 'ParcelMarkDelivered':
        return { fulfillmentMarkDelivered: { userErrors: [] } };
      case 'ParcelMarkReturning':
        return { fulfillmentMarkReturning: { userErrors: [] } };
      case 'ParcelEventCreate':
        return { fulfillmentEventCreate: { userErrors: [] } };
      case 'ParcelReceive':
        return { fulfillmentReceiveReturn: { userErrors: [] } };
      case 'FulfillmentTrackingInfoUpdate': {
        const number = (variables.trackingInfo as { number: string | null }).number;
        const userErrors =
          number === 'LE 44'
            ? [
                {
                  field: ['trackingInfo', 'number'],
                  code: 'INVALID',
                  message: 'has no spaces in Leopards numbers',
                },
              ]
            : [];
        return { fulfillmentTrackingInfoUpdate: { userErrors } };
      }
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

  it("corrects a delivered parcel's tracking, its link https and its refusal named", async () => {
    const fake = core('packer', [parcel('DELIVERED', { deliveredAt: LATER })]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Change tracking' }));
    expect((screen.getByLabelText('Courier') as HTMLInputElement).value).toBe('Leopards');
    expect((screen.getByLabelText('Tracking number') as HTMLInputElement).value).toBe('LE4402917');
    const save = screen.getByRole('button', { name: 'Save tracking' }) as HTMLButtonElement;
    type('Tracking link', 'http://leopardscourier.com/track');
    expect(screen.getByText('A tracking link starts with https://')).toBeTruthy();
    expect(save.disabled).toBe(true);

    type('Tracking link', ' https://leopardscourier.com/track?cn=LE4402918 ');
    type('Tracking number', 'LE 44');
    fireEvent.click(save);
    expect(
      await screen.findByText('Tracking number: has no spaces in Leopards numbers'),
    ).toBeTruthy();

    type('Tracking number', 'LE4402918');
    type('Courier', ' ');
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByLabelText('Tracking number')).toBeNull());
    expect(
      fake.sent
        .filter((each) => each.operation === 'FulfillmentTrackingInfoUpdate')
        .map((each) => each.variables)
        .at(-1),
    ).toEqual({
      id: 'ful_1',
      trackingInfo: {
        company: null,
        number: 'LE4402918',
        url: 'https://leopardscourier.com/track?cn=LE4402918',
      },
    });
  });

  it("ships a packed order by hand with any courier's tracking, a part refused named", async () => {
    const fake = core('packer', [], 'TO_BOOK');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as shipped' }));
    expect(screen.getByRole('heading', { name: 'Mark #1007 as shipped' })).toBeTruthy();
    // Couriers offered as the merchant types, any other typed as it is.
    const courier = screen.getByLabelText('Courier') as HTMLInputElement;
    const offered = document.getElementById(courier.getAttribute('list')!)!;
    expect([...offered.querySelectorAll('option')].map((each) => each.value)).toContain('TCS');
    // One form at a time: the button that opened it waits until it is done.
    expect(screen.getAllByRole('button', { name: 'Mark as shipped' })).toHaveLength(1);

    type('Courier', 'TCS');
    type('Tracking number', '77 12');
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(await screen.findByText('Tracking number: is too short')).toBeTruthy();

    type('Tracking number', ' 7712345678 ');
    fireEvent.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    await waitFor(() => expect(screen.queryByLabelText('Tracking number')).toBeNull());
    expect(
      fake.sent
        .filter((each) => each.operation === 'OrderFulfill')
        .map((each) => each.variables)
        .at(-1),
    ).toEqual({
      id: 'ord_7',
      trackingInfo: { company: 'TCS', number: '7712345678', url: null },
    });
  });

  it('offers shipping by hand where something is left to ship, to those who work orders', async () => {
    const left = core('owner', [parcel('IN_TRANSIT')], 'PARTIALLY_FULFILLED');
    vi.stubGlobal('fetch', left.fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as shipped' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Tracking number')).toBeNull();
    cleanup();

    // To pack: packed first, as the pipeline has it.
    vi.stubGlobal('fetch', core('owner', [], 'TO_PACK').fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    await screen.findByRole('button', { name: 'Mark packed' });
    expect(screen.queryByRole('button', { name: 'Mark as shipped' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('accountant', [], 'TO_BOOK').fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    await screen.findByRole('heading', { name: '#1007' });
    expect(screen.queryByRole('button', { name: 'Mark as shipped' })).toBeNull();
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
    expect(within(parcels).queryByRole('button', { name: 'Change tracking' })).toBeNull();
  });
});

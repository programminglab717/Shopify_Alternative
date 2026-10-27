import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiderValue } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const AGO = new Date(Date.now() - 3_600_000).toISOString();

function packed(id: string, name: string) {
  return {
    id,
    name,
    createdAt: AGO,
    stage: 'TO_BOOK',
    paymentMethod: 'CASH_ON_DELIVERY',
    overPlanLimit: false,
    totalPrice: pkr('5599.00'),
    customer: { displayName: 'Ayesha Khan' },
    shippingAddress: { name: 'Ayesha Khan', city: 'Lahore' },
    risk: { level: 'LOW' },
    lineItems: [{ quantity: 1 }],
  };
}

const ASIF: RiderValue = {
  id: 'ridr_1',
  name: 'Asif',
  phone: '+923001112223',
  active: true,
  out: 1,
  cashHeld: pkr('4000.00'),
};

const LINK = 'https://api.hatti.test/rider/AbCdEfGhIjKlMnOpQrStUv';

function core(role: StaffRole) {
  let riders: RiderValue[] = [ASIF];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Shipping':
        return {
          shop: { timezone: 'Asia/Karachi' },
          courierAccounts: [],
          courierBookings: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'Orders':
        return {
          orders: {
            nodes: [packed('ord_1', '#1011'), packed('ord_2', '#1012')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [],
        };
      case 'Riders':
        return { riders };
      case 'RiderDetail':
        return {
          riderDeliveries: [
            {
              id: 'rdel_1',
              riderId: 'ridr_1',
              orderId: 'ord_9',
              status: 'DELIVERED',
              cashDue: pkr('4000.00'),
              cashCollected: pkr('4000.00'),
              codeSent: true,
              codeGiven: true,
              failedReason: null,
              deliveredAt: AGO,
              failedAt: null,
              createdAt: AGO,
            },
          ],
          ...(variables.cash ? { riderHandovers: [] } : {}),
        };
      case 'RiderCreate': {
        const input = variables.input as { name: string; phone: string };
        const made = {
          ...ASIF,
          id: 'ridr_2',
          name: input.name,
          phone: '+923211112223',
          out: 0,
          cashHeld: pkr('0.00'),
        };
        riders = [...riders, made];
        return { riderCreate: { rider: made, link: LINK, userErrors: [] } };
      }
      case 'RiderHandOut':
        return {
          riderHandOut: {
            results: [
              { orderId: 'ord_1', problem: null, delivery: { id: 'rdel_2' } },
              { orderId: 'ord_2', problem: 'Confirm the order first', delivery: null },
            ],
            userErrors: [],
          },
        };
      case 'RiderHandOver':
        riders = riders.map((each) =>
          each.id === variables.riderId ? { ...each, cashHeld: pkr('1000.00') } : each,
        );
        return {
          riderHandOver: {
            handover: { id: 'rhnd_1' },
            rider: riders.find((each) => each.id === variables.riderId),
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

describe("The shop's own riders in the admin (SHP-10, ADR-827)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hands packed orders to a rider, naming those refused', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping');
    fireEvent.click(await screen.findByLabelText('Select #1011'));
    fireEvent.click(screen.getByLabelText('Select #1012'));
    fireEvent.click(screen.getByRole('button', { name: 'Hand 2 to a rider' }));
    expect(await screen.findByLabelText('Rider')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hand out' }));
    expect(await screen.findByText('#1012: Confirm the order first')).toBeTruthy();
    expect(sentOf(fake, 'RiderHandOut')).toEqual([
      { riderId: 'ridr_1', orderIds: ['ord_1', 'ord_2'] },
    ]);
  });

  it('adds a rider, showing their link once to send on WhatsApp, and takes cash a rider hands over', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping?tab=riders');
    const list = await screen.findByRole('list', { name: 'Riders' });
    expect(within(list).getByText('Carrying 1 · holding Rs 4,000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bilal' } });
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '0321 1112223' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rider' }));
    expect(await screen.findByText(LINK)).toBeTruthy();
    const send = screen.getByRole('link', { name: 'Send it on WhatsApp' });
    expect(send.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/923211112223\?text=/);
    expect(decodeURIComponent(send.getAttribute('href')!)).toContain(LINK);
    expect(sentOf(fake, 'RiderCreate')).toEqual([
      { input: { name: 'Bilal', phone: '0321 1112223' } },
    ]);

    const asif = within(list).getByText('Asif').closest('li')!;
    fireEvent.click(within(asif).getByRole('button', { name: 'Deliveries and cash' }));
    expect(await within(asif).findByText('Code given')).toBeTruthy();
    fireEvent.change(within(asif).getByLabelText('Amount (Rs)'), { target: { value: '3,000' } });
    fireEvent.click(within(asif).getByRole('button', { name: 'Record cash' }));
    await waitFor(() =>
      expect(sentOf(fake, 'RiderHandOver')).toEqual([
        { riderId: 'ridr_1', input: { amount: '3000', note: null } },
      ]),
    );
    expect(await within(asif).findByText('Carrying 1 · holding Rs 1,000')).toBeTruthy();
  });

  it('leaves adding riders to owners and managers, and their cash to those who reconcile', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/shipping?tab=riders');
    const list = await screen.findByRole('list', { name: 'Riders' });
    expect(screen.queryByRole('button', { name: 'Add rider' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'New link' })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Deliveries and cash' }));
    expect(await within(list).findByText('Code given')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Record cash' })).toBeNull();
  });
});

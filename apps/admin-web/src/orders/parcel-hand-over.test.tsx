import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** An order shipped as one parcel, handed over as `handOver` says. */
function core(role: StaffRole, handOver: Record<string, unknown> | null) {
  return fakeCore(role, (operation) => {
    if (operation !== 'Order') throw new Error(`unexpected ${operation}`);
    return {
      shop: { timezone: 'Asia/Karachi' },
      paymentSessions: [],
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
        location: { id: 'loc_1', name: 'Main location' },
        note: null,
        tags: [],
        phone: '+923001234567',
        email: null,
        source: 'WEB',
        lineItems: [],
        subtotalPrice: rupees('2500'),
        totalShippingPrice: rupees('200'),
        totalDiscounts: rupees('0'),
        codFee: rupees('0'),
        totalPrice: rupees('2700'),
        amountPaid: rupees('0'),
        codAmount: rupees('2700'),
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
        fulfillments: [
          {
            id: 'ful_1',
            status: 'IN_TRANSIT',
            shippedAt: LATER,
            deliveredAt: null,
            returningAt: null,
            returnedAt: null,
            lostAt: null,
            trackingInfo: { company: 'PostEx', number: 'PX1001', url: null },
            fulfillmentLineItems: [],
            events: { nodes: [] },
            claim: null,
            handOver,
          },
        ],
        returns: [],
        events: { nodes: [] },
      },
    };
  });
}

describe("A parcel's hand-over to its courier, on the order's page (ADR-381)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says when and to whom it was handed over, and that the courier's tracking has it", async () => {
    vi.stubGlobal(
      'fetch',
      core('owner', {
        handedOverAt: hoursAgo(3),
        byHand: true,
        riderName: 'Imran',
        seen: true,
        unseen: false,
      }).fetcher,
    );
    renderAdmin('/shop_1/orders/ord_7');
    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    expect(await within(parcels).findByText(/^Handed to Imran/)).toBeTruthy();
    expect(within(parcels).getByText('By hand, without asking the courier')).toBeTruthy();
    expect(within(parcels).getByText('The courier has it')).toBeTruthy();
    expect(within(parcels).queryByText(/still has it as only booked/)).toBeNull();
  });

  it('warns of one the courier has not seen a day on, a tap from the pickups', async () => {
    const unseen = { handedOverAt: hoursAgo(30), byHand: false, riderName: null };
    vi.stubGlobal('fetch', core('packer', { ...unseen, seen: false, unseen: true }).fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    expect(await within(parcels).findByText(/^Handed over/)).toBeTruthy();
    expect(within(parcels).getByText(/still has it as only booked/)).toBeTruthy();
    expect(within(parcels).getByRole('link', { name: 'See pickups' }).getAttribute('href')).toBe(
      '/shop_1/shipping?tab=pickups',
    );
    expect(within(parcels).queryByText('The courier has it')).toBeNull();
    cleanup();

    // Staff who do not hand parcels over are told, without the way to the pickups.
    vi.stubGlobal(
      'fetch',
      core('confirmation_agent', { ...unseen, seen: false, unseen: true }).fetcher,
    );
    renderAdmin('/shop_1/orders/ord_7');
    const again = await screen.findByRole('region', { name: 'Parcels' });
    expect(await within(again).findByText(/still has it as only booked/)).toBeTruthy();
    expect(within(again).queryByRole('link', { name: 'See pickups' })).toBeNull();
  });

  it('says nothing of a hand-over the parcel never had', async () => {
    vi.stubGlobal('fetch', core('owner', null).fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    const parcels = await screen.findByRole('region', { name: 'Parcels' });
    expect(await within(parcels).findByText('PostEx · PX1001')).toBeTruthy();
    expect(within(parcels).queryByText(/^Handed/)).toBeNull();
  });
});

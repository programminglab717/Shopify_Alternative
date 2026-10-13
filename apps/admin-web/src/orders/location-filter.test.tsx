import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const listed = (id: string, name: string) => ({
  id,
  name,
  createdAt: LATER,
  stage: 'TO_PACK',
  paymentMethod: 'CASH_ON_DELIVERY',
  overPlanLimit: false,
  totalPrice: rupees('2700'),
  customer: { displayName: 'Ayesha Khan' },
  shippingAddress: { name: 'Ayesha Khan', city: 'Lahore' },
  risk: { level: 'LOW' },
  lineItems: [{ quantity: 1 }],
});

const LOCATIONS = [
  { id: 'loc_1', name: 'Lahore warehouse', isPrimary: true },
  { id: 'loc_2', name: 'Karachi store', isPrimary: false },
];

function core(locations = LOCATIONS) {
  return fakeCore('packer', (operation, variables) => {
    switch (operation) {
      case 'Locations':
        return { locations: { nodes: locations } };
      case 'Orders': {
        const karachi = variables.locationId === 'loc_2';
        return {
          orders: {
            nodes: karachi ? [listed('ord_2', '#1012')] : [listed('ord_1', '#1011')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [{ stage: 'TO_PACK', count: karachi ? 1 : 7 }],
        };
      }
      case 'SetupChecklist':
        return { setupChecklist: { done: 8, total: 8, steps: [] } };
      case 'HomeStock':
        return {
          home: {
            lowStock: { low: 0, out: 0, threshold: 5 },
            // One transfer on its way to Karachi, and another to Lahore (ADR-364).
            transfersToReceive: variables.locationId ? 1 : 2,
          },
        };
      case 'Home': {
        const tally = (count: number) => ({ count, total: rupees(String(count * 2700)) });
        const karachi = variables.locationId === 'loc_2';
        return {
          shop: { timezone: 'Asia/Karachi' },
          home: {
            toConfirm: tally(karachi ? 0 : 3),
            toReview: tally(0),
            awaitingPayment: tally(0),
            transfersToCheck: tally(0),
            toPack: tally(karachi ? 1 : 7),
            toBook: tally(0),
            readyForPickup: tally(0),
            returning: tally(0),
            returnsToReceive: tally(0),
            lostToClaim: tally(0),
            claimsOpen: tally(0),
            cashToCollect: tally(0),
            today: {
              since: LATER,
              sales: tally(0),
              salesYesterday: tally(0),
              delivered: tally(0),
              returnedToOrigin: tally(0),
            },
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const ordersSent = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'Orders').map((each) => each.variables);

describe('The orders each location ships (INV-10)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a location's orders and counts, and keeps the choice for next time", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders?q=lawn');

    expect(await screen.findByText('#1011')).toBeTruthy();
    const where = screen.getByLabelText('Ships from') as HTMLSelectElement;
    expect([...where.options].map((option) => option.text)).toEqual([
      'Every location',
      'Lahore warehouse',
      'Karachi store',
    ]);
    // The list is read once, after the locations, for every location.
    expect(ordersSent(fake)).toEqual([
      { first: 50, after: null, query: 'lawn', stage: null, locationId: null },
    ]);

    fireEvent.change(where, { target: { value: 'loc_2' } });
    expect(await screen.findByText('#1012')).toBeTruthy();
    expect(ordersSent(fake).at(-1)).toEqual({
      first: 50,
      after: null,
      query: 'lawn location_id:loc_2',
      stage: null,
      locationId: 'loc_2',
    });
    cleanup();

    // Back on the list another day, Karachi's orders come first of all.
    const again = core();
    vi.stubGlobal('fetch', again.fetcher);
    renderAdmin('/shop_1/orders');
    expect(await screen.findByText('#1012')).toBeTruthy();
    expect(ordersSent(again)).toEqual([
      { first: 50, after: null, query: 'location_id:loc_2', stage: null, locationId: 'loc_2' },
    ]);
    fireEvent.change(screen.getByLabelText('Ships from'), { target: { value: '' } });
    await waitFor(() => expect(ordersSent(again).at(-1)?.locationId).toBeNull());
    expect(window.localStorage.getItem('hatti.ordersLocation.shop_1')).toBe('');
  });

  it('offers no choice to a shop with one location', async () => {
    vi.stubGlobal('fetch', core(LOCATIONS.slice(0, 1)).fetcher);
    renderAdmin('/shop_1/orders');
    expect(await screen.findByText('#1011')).toBeTruthy();
    expect(screen.queryByLabelText('Ships from')).toBeNull();
  });

  it("counts the home's orders at the location chosen on the orders list", async () => {
    window.localStorage.setItem('hatti.ordersLocation.shop_1', 'loc_2');
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1');

    expect(await screen.findByText(/1 order to pack/i)).toBeTruthy();
    const homes = () =>
      fake.sent.filter((each) => each.operation === 'Home').map((each) => each.variables);
    expect(homes()).toEqual([{ locationId: 'loc_2' }]);
    // What is on its way to Karachi, to receive, a tap from the transfers (ADR-364).
    const coming = await screen.findByRole('link', { name: /1 transfer on its way/ });
    expect(coming.getAttribute('href')).toBe('/shop_1/transfers');
    fireEvent.change(screen.getByLabelText('Ships from'), { target: { value: '' } });
    expect(await screen.findByText(/7 orders to pack/i)).toBeTruthy();
    expect(homes().at(-1)).toEqual({ locationId: null });
    expect(await screen.findByRole('link', { name: /2 transfers on their way/ })).toBeTruthy();
    expect(
      fake.sent.filter((each) => each.operation === 'HomeStock').map((each) => each.variables),
    ).toEqual([{ locationId: 'loc_2' }, { locationId: null }]);
  });
});

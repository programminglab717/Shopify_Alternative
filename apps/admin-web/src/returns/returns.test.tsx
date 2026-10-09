import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';
import { trackingText } from './parcel';
import { validateReturnsSearch } from './returns-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });
const tracking = (company: string, number: string) => ({ company, number });

const RETURNING = {
  returningParcels: {
    nodes: [
      {
        id: 'ful_1',
        orderId: 'ord_7',
        orderName: '#1007',
        days: 16,
        units: 2,
        trackingInfo: tracking('PostEx', 'PX10293847'),
      },
      {
        id: 'ful_2',
        orderId: 'ord_9',
        orderName: '#1009',
        days: 0,
        units: 1,
        trackingInfo: tracking('Leopards', 'LE4402917'),
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};

const ok = (mutation: string) => ({ [mutation]: { userErrors: [] } });

const claim = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  amount: rupees('5900'),
  paid: null,
  note: 'TCS-CLM-118',
  claimedAt: LATER,
  settledAt: null,
  ...extra,
});

describe('Parcels coming back, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets a packer check parcels in by tracking number or from the list, or mark one lost', async () => {
    const core = fakeCore('packer', (operation) => {
      switch (operation) {
        case 'ReturningParcels':
          return RETURNING;
        case 'ParcelCheckIn':
          return {
            fulfillmentReceiveReturn: { order: { id: 'ord_7', name: '#1007' }, userErrors: [] },
          };
        case 'ParcelMarkLost':
          return ok('fulfillmentMarkLost');
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/returns');

    await screen.findByText('PostEx · PX10293847');
    // Sixteen days on its way back is slow, in red; since today is not.
    expect(screen.getByText('16 days on its way back').className).toContain('text-danger');
    expect(screen.getByText('Coming back since today').className).not.toContain('text-danger');
    // Packers check in; claims are for those who settle money with couriers.
    expect(screen.queryByRole('tab', { name: 'Claims' })).toBeNull();

    type('Tracking number', ' px10293847 ');
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await screen.findByText('#1007 checked in: its items are back in stock.');
    expect(core.sent.find((each) => each.operation === 'ParcelCheckIn')?.variables).toEqual({
      trackingNumber: 'px10293847',
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Check it in' })[1]!);
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'ParcelCheckIn').at(-1)?.variables,
      ).toEqual({ id: 'ful_2' }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Courier lost it' })[0]!);
    expect(screen.getByText(/Its items are written off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark lost' }));
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'ParcelMarkLost')?.variables).toEqual({
        id: 'ful_1',
      }),
    );
  });

  it("lets an accountant claim a lost parcel's worth from its courier, with the claim number", async () => {
    const core = fakeCore('accountant', (operation) => {
      switch (operation) {
        case 'LostParcels':
          return {
            lostParcels: {
              nodes: [
                {
                  id: 'ful_3',
                  orderId: 'ord_5',
                  orderName: '#1005',
                  days: 4,
                  units: 1,
                  worth: rupees('5900.00'),
                  trackingInfo: tracking('TCS', '779012345678'),
                  claim: null,
                },
                {
                  id: 'ful_4',
                  orderId: 'ord_6',
                  orderName: '#1006',
                  days: 30,
                  units: 3,
                  worth: rupees('8200.00'),
                  trackingInfo: tracking('TCS', '779012345679'),
                  claim: claim('OPEN'),
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        case 'ParcelClaimCreate':
          return ok('fulfillmentClaimCreate');
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/returns?tab=lost');

    await screen.findByText('Not claimed');
    expect(screen.getByText('Claim open')).toBeTruthy();
    // Accountants check nothing in, and only an unclaimed parcel can be claimed.
    expect(screen.queryByLabelText('Tracking number')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Claim from the courier' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Claim from the courier' }));
    expect((screen.getByLabelText('Amount to claim') as HTMLInputElement).value).toBe('5900');
    type('Note', 'TCS-CLM-120');
    fireEvent.click(screen.getByRole('button', { name: 'File the claim' }));
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'ParcelClaimCreate')?.variables).toEqual({
        id: 'ful_3',
        amount: '5900',
        note: 'TCS-CLM-120',
      }),
    );
  });

  it('lists claims to follow up and records what the courier did', async () => {
    const core = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'ParcelClaims':
          return {
            parcelClaims: {
              nodes: [
                {
                  id: 'ful_4',
                  orderId: 'ord_6',
                  orderName: '#1006',
                  status: 'RETURNED',
                  trackingInfo: tracking('TCS', '779012345679'),
                  claim: claim('OPEN'),
                },
                ...(variables.status
                  ? []
                  : [
                      {
                        id: 'ful_8',
                        orderId: 'ord_8',
                        orderName: '#1008',
                        status: 'LOST',
                        trackingInfo: tracking('PostEx', 'PX1'),
                        claim: claim('PAID', { paid: rupees('5000') }),
                      },
                    ]),
              ],
              pageInfo: { hasNextPage: false },
            },
          };
        case 'ParcelClaimSettle':
          return ok('fulfillmentClaimSettle');
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/returns?tab=claims');

    await screen.findByText('Came back damaged');
    expect(core.sent.find((each) => each.operation === 'ParcelClaims')?.variables).toEqual({
      status: ['OPEN', 'REFUSED'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Record what happened' }));
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'REFUSED' } });
    // Refused, there is no amount: why goes in its place.
    expect(screen.queryByLabelText('Amount paid')).toBeNull();
    type('Why it was refused', 'Packed without bubble wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'ParcelClaimSettle')?.variables).toEqual({
        id: 'ful_4',
        status: 'REFUSED',
        amount: null,
        note: 'Packed without bubble wrap',
      }),
    );

    fireEvent.click(screen.getByLabelText('Show settled claims too'));
    await screen.findByText('Claim paid');
    expect(screen.getByText(/Rs 5,000 paid/)).toBeTruthy();
  });

  it("opens the home's lost parcels and claims on their tabs, and is for those who handle returns", async () => {
    const tally = (count: number, amount = '0') => ({ count, total: rupees(amount) });
    const core = fakeCore('owner', (operation) => {
      if (operation === 'SetupChecklist') {
        return { setupChecklist: { done: 8, total: 8, steps: [] } };
      }
      if (operation !== 'Home') throw new Error(`unexpected ${operation}`);
      return {
        shop: { timezone: 'Asia/Karachi' },
        home: {
          toConfirm: tally(0),
          toReview: tally(0),
          awaitingPayment: tally(0),
          transfersToCheck: tally(0),
          toPack: tally(0),
          toBook: tally(0),
          returning: tally(0),
          returnsToReceive: tally(0),
          cashToCollect: tally(4, '12000'),
          lostToClaim: tally(1, '5900'),
          claimsOpen: tally(2, '14100'),
          today: {
            since: LATER,
            sales: tally(0),
            salesYesterday: tally(0),
            delivered: tally(0),
            returnedToOrigin: tally(0),
          },
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1');

    const lost = await screen.findByRole('link', { name: /1 lost parcel to claim/ });
    expect(lost.getAttribute('href')).toBe('/shop_1/returns?tab=lost');
    expect(screen.getByRole('link', { name: /2 courier claims open/ }).getAttribute('href')).toBe(
      '/shop_1/returns?tab=claims',
    );
    expect(
      screen.getByRole('link', { name: /Cash on delivery still to come/ }).getAttribute('href'),
    ).toBe('/shop_1/cash');

    expect(trackingText({ company: null, number: 'PX1' })).toBe('PX1');
    expect(validateReturnsSearch({ tab: 'claims' })).toEqual({ tab: 'claims' });
    expect(validateReturnsSearch({ tab: 'back' })).toEqual({});
    expect(validateReturnsSearch({ tab: 'nonsense' })).toEqual({});
    for (const role of ['owner', 'manager', 'packer', 'accountant'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/returns')).toBe(true);
    }
    for (const role of ['confirmation_agent', 'marketer'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/returns')).toBe(false);
    }
  });
});

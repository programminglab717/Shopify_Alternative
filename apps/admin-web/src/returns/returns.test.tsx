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
          readyForPickup: tally(0),
          returning: tally(0),
          returnsToReceive: tally(1, '2500'),
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
    expect(
      screen.getByRole('link', { name: /1 customer return to receive/ }).getAttribute('href'),
    ).toBe('/shop_1/returns?tab=customer');

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
  it('lists failed deliveries with what each customer answered, and Home counts them (ADR-388)', async () => {
    const parcel = (id: string, extra: Record<string, unknown>) => ({
      id,
      orderId: `ord_${id}`,
      orderName: `#10${id}`,
      customerName: 'Ayesha Khan',
      city: 'Karachi',
      trackingInfo: tracking('PostEx', `PX${id}`),
      attemptedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      reason: 'Customer not available',
      attempts: 1,
      answer: null,
      answeredAt: null,
      ...extra,
    });
    const core = fakeCore('packer', (operation) => {
      if (operation !== 'DeliveriesToRescue') throw new Error(`unexpected ${operation}`);
      return {
        deliveriesToRescue: {
          count: 4,
          parcels: [
            parcel('31', { answer: 'CALL', answeredAt: LATER }),
            parcel('32', { answer: 'RETRY', answeredAt: LATER, attempts: 2, reason: null }),
            parcel('33', { customerName: null, city: null }),
          ],
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/returns?tab=rescue');

    await screen.findByText('PostEx · PX31');
    expect(
      screen.getByRole('tab', { name: 'Failed deliveries' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('Call first')).toBeTruthy();
    expect(screen.getByText('Deliver again')).toBeTruthy();
    expect(screen.getByText('No answer yet')).toBeTruthy();
    expect(screen.getAllByText('Ayesha Khan · Karachi')).toHaveLength(2);
    expect(screen.getAllByText(/^Attempts: 1 · last 2 hours ago/)).toHaveLength(2);
    expect(screen.getAllByText('“Customer not available”')).toHaveLength(2);
    expect(screen.getByText('Attempts: 2 · last 2 hours ago')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#1031' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_31',
    );
    expect(screen.getByText('Showing 3 of 4.')).toBeTruthy();
    expect(validateReturnsSearch({ tab: 'rescue' })).toEqual({ tab: 'rescue' });
    cleanup();

    const empty = fakeCore('owner', () => ({ deliveriesToRescue: { count: 0, parcels: [] } }));
    vi.stubGlobal('fetch', empty.fetcher);
    renderAdmin('/shop_1/returns?tab=rescue');
    expect(await screen.findByText('No deliveries have failed.')).toBeTruthy();
    cleanup();

    // Home: a tap to them for those who handle parcels coming back.
    const tally = (count: number) => ({ count, total: rupees('0') });
    const home = (role: 'owner' | 'confirmation_agent', deliveriesToRescue: number) =>
      fakeCore(role, (operation) => {
        if (operation === 'SetupChecklist') {
          return { setupChecklist: { done: 8, total: 8, steps: [] } };
        }
        if (operation === 'HomeStock') {
          return { home: { lowStock: { low: 0, out: 0, threshold: 5 }, transfersToReceive: 0 } };
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
            readyForPickup: tally(0),
            returning: tally(0),
            returnsToReceive: tally(0),
            cashToCollect: tally(0),
            lostToClaim: tally(0),
            claimsOpen: tally(0),
            parcelsUnseen: 0,
            deliveriesToRescue,
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
    vi.stubGlobal('fetch', home('owner', 3).fetcher);
    renderAdmin('/shop_1');
    const link = await screen.findByRole('link', { name: /3 failed deliveries to rescue/ });
    expect(link.getAttribute('href')).toBe('/shop_1/returns?tab=rescue');
    cleanup();
    vi.stubGlobal('fetch', home('owner', 1).fetcher);
    renderAdmin('/shop_1');
    expect(await screen.findByRole('link', { name: /A failed delivery to rescue/ })).toBeTruthy();
    cleanup();
    vi.stubGlobal('fetch', home('confirmation_agent', 3).fetcher);
    renderAdmin('/shop_1');
    await screen.findByText('All caught up. New orders will show here.');
    expect(screen.queryByText(/failed deliveries/)).toBeNull();
  });

  it('lists customer returns on their way, the slow in red, and receives one all back in stock', async () => {
    const fake = fakeCore('packer', (operation) => {
      if (operation === 'OpenReturns') {
        return {
          openReturns: {
            nodes: [
              {
                id: 'ret_1',
                name: '#1007-R1',
                orderId: 'ord_7',
                days: 15,
                units: 2,
                exchangeOrderName: '#1019',
                trackingInfo: tracking('TCS', '779000111'),
              },
              {
                id: 'ret_2',
                name: '#1011-R1',
                orderId: 'ord_11',
                days: 0,
                units: 1,
                exchangeOrderName: null,
                trackingInfo: tracking(null as unknown as string, null as unknown as string),
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      if (operation === 'ReturnReceive') return ok('returnReceive');
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/returns?tab=customer');

    const first = await screen.findByRole('link', { name: '#1007-R1' });
    expect(first.getAttribute('href')).toBe('/shop_1/orders/ord_7');
    expect(screen.getByText('15 days on its way').className).toContain('text-danger');
    expect(screen.getByText('Recorded today').className).not.toContain('text-danger');
    expect(screen.getByText('Exchange: #1019')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Received: all back in stock' })[1]!);
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'ReturnReceive')?.variables).toEqual({
        id: 'ret_2',
      }),
    );
  });

  it('lists returns customers asked for online, approved into a return or declined saying why (ADR-677)', async () => {
    let waiting = [
      {
        id: 'retq_1',
        orderId: 'ord_7',
        orderName: '#1007',
        preference: 'EXCHANGE',
        note: 'Size 9 please',
        createdAt: LATER,
        lineItems: [
          {
            lineItemId: 'li_1',
            title: 'Peshawari Chappal',
            variantTitle: '8',
            quantity: 2,
            returnReason: 'SIZE_TOO_SMALL',
          },
        ],
      },
      {
        id: 'retq_2',
        orderId: 'ord_9',
        orderName: '#1009',
        preference: 'REFUND',
        note: '',
        createdAt: LATER,
        lineItems: [
          {
            lineItemId: 'li_2',
            title: 'Multani Khussa',
            variantTitle: 'Default Title',
            quantity: 1,
            returnReason: 'DEFECTIVE',
          },
        ],
      },
    ];
    const fake = fakeCore('packer', (operation, variables) => {
      switch (operation) {
        case 'ReturnRequests':
          return { returnRequests: { nodes: waiting, pageInfo: { hasNextPage: false } } };
        case 'ReturnRequestApprove':
          waiting = waiting.filter((each) => each.id !== variables?.id);
          return {
            returnRequestApprove: { return: { id: 'ret_1', name: '#1007-R1' }, userErrors: [] },
          };
        case 'ReturnRequestDecline':
          waiting = waiting.filter((each) => each.id !== variables?.id);
          return { returnRequestDecline: { returnRequest: { id: 'retq_2' }, userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/returns?tab=asked');

    expect((await screen.findByRole('link', { name: '#1007' })).getAttribute('href')).toBe(
      '/shop_1/orders/ord_7',
    );
    expect(screen.getByText(/Peshawari Chappal · 8/)).toBeTruthy();
    expect(screen.getByText(/· Too small/)).toBeTruthy();
    expect(screen.getByText('Would like another size or item')).toBeTruthy();
    expect(screen.getByText('Size 9 please')).toBeTruthy();
    // A product without variants is named alone.
    expect(screen.getByText(/^Multani Khussa/).textContent).not.toContain('Default Title');

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    expect(
      await screen.findByText(/Approved as #1007-R1: check it in on its order when it comes./),
    ).toBeTruthy();
    expect(fake.sent.find((each) => each.operation === 'ReturnRequestApprove')?.variables).toEqual({
      id: 'retq_1',
    });

    // Declining asks why, which the customer is told.
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    const send = screen.getByRole('button', { name: 'Decline and tell them' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type('Why you are declining it', '  Worn shoes are not taken back ');
    fireEvent.click(send);
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'ReturnRequestDecline')?.variables,
      ).toEqual({ id: 'retq_2', reason: 'Worn shoes are not taken back' }),
    );
    expect(await screen.findByText('No returns waiting for an answer')).toBeTruthy();
  });

  it('shows the asked-online tab to those who handle returns', () => {
    expect(validateReturnsSearch({ tab: 'asked' })).toEqual({ tab: 'asked' });
  });
});

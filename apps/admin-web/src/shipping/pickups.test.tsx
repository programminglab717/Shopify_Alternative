import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const AGO = new Date(Date.now() - 3_600_000).toISOString();

const POSTEX = {
  id: 'acc_1',
  name: 'PostEx Lahore',
  courier: 'postex',
  courierName: 'PostEx',
  isDefault: true,
};
const LEOPARDS = {
  id: 'acc_2',
  name: 'Leopards',
  courier: 'leopards',
  courierName: 'Leopards',
  isDefault: false,
};
const TRAX = { id: 'acc_3', name: 'Trax', courier: 'trax', courierName: 'Trax', isDefault: false };

function pickup(
  id: string,
  accountId: string,
  status: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    accountId,
    courierName: accountId === 'acc_2' ? 'Leopards' : 'PostEx',
    status,
    byHand: false,
    parcelCount: 0,
    handedOverCount: 0,
    reference: null,
    loadSheetUrl: null,
    error: null,
    riderName: null,
    riderCode: null,
    createdAt: AGO,
    requestedAt: null,
    ...more,
  };
}

function core(accounts = [POSTEX, LEOPARDS, TRAX]) {
  let pickups = [
    pickup('pk_1', 'acc_1', 'REQUESTED', {
      parcelCount: 12,
      loadSheetUrl: 'https://postex.example/sheet.pdf',
      requestedAt: AGO,
    }),
    pickup('pk_2', 'acc_2', 'FAILED', {
      parcelCount: 3,
      error: 'Leopards does not know rider R-9',
    }),
  ];
  let waited = 0;
  // The rider's parcels of pk_1, by tracking number; true once handed over (ADR-377).
  const parcels = new Map([
    ['PX100201', { order: '#1031', handed: false }],
    ['PX100202', { order: '#1032', handed: false }],
    ['PX100203', { order: '#1033', handed: false }],
  ]);
  const parcelOf = (number: string) => ({
    booking: {
      id: `cb_${number}`,
      orderId: `ord_${number}`,
      orderName: parcels.get(number)!.order,
      trackingNumber: number,
    },
    handedOverAt: parcels.get(number)!.handed ? AGO : null,
  });
  return fakeCore('packer', (operation, variables) => {
    switch (operation) {
      case 'CourierPickupParcels':
        return {
          courierPickup: {
            id: variables.id,
            parcelCount: parcels.size,
            handedOverCount: [...parcels.values()].filter((each) => each.handed).length,
            parcels: [...parcels.keys()].map(parcelOf),
          },
        };
      case 'CourierPickupParcelHandOver': {
        const number = String(variables.trackingNumber).replace(/\s+/g, '').toUpperCase();
        const parcel = parcels.get(number);
        if (!parcel) {
          return {
            courierPickupParcelHandOver: {
              parcel: null,
              alreadyHandedOver: false,
              userErrors: [
                {
                  field: ['trackingNumber'],
                  code: 'NOT_FOUND',
                  message: 'No parcel of this pickup has that tracking number',
                },
              ],
            },
          };
        }
        const already = parcel.handed;
        parcel.handed = true;
        return {
          courierPickupParcelHandOver: {
            parcel: parcelOf(number),
            alreadyHandedOver: already,
            userErrors: [],
          },
        };
      }
      case 'Pickups':
        // The courier answers on the second read after it was asked.
        if (pickups.some((each) => each.status === 'REQUESTING') && ++waited > 1) {
          pickups = pickups.map((each) =>
            each.status === 'REQUESTING'
              ? { ...each, status: 'REQUESTED', reference: 'LS-4471', requestedAt: AGO }
              : each,
          );
        }
        return {
          shop: { timezone: 'Asia/Karachi' },
          couriers: [
            { courier: 'postex', pickups: { rider: false } },
            { courier: 'leopards', pickups: { rider: true } },
            { courier: 'trax', pickups: null },
          ],
          courierAccounts: accounts,
          courierPickups: pickups,
        };
      case 'CourierPickupRecordByHand': {
        const input = variables.input as { accountId: string; riderName?: string };
        const made = pickup('pk_4', input.accountId, 'REQUESTED', {
          byHand: true,
          parcelCount: 3,
          riderName: input.riderName ?? null,
          requestedAt: AGO,
        });
        pickups = [made, ...pickups];
        return { courierPickupRecordByHand: { courierPickup: made, userErrors: [] } };
      }
      case 'CourierPickupRequest': {
        const input = variables.input as { accountId: string; riderName?: string };
        if (input.accountId === 'acc_1') {
          return {
            courierPickupRequest: {
              courierPickup: null,
              userErrors: [
                {
                  field: null,
                  code: 'NOTHING_WAITING',
                  message: 'No parcels wait to be picked up',
                },
              ],
            },
          };
        }
        const made = pickup('pk_3', input.accountId, 'REQUESTING', {
          parcelCount: 5,
          riderName: input.riderName,
          riderCode: 'R-12',
        });
        pickups = [made, ...pickups];
        return { courierPickupRequest: { courierPickup: made, userErrors: [] } };
      }
      case 'Shipping':
        return {
          shop: { timezone: 'Asia/Karachi' },
          courierAccounts: accounts,
          courierBookings: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'CourierLoadSheet':
        return { courierLoadSheet: { title: 'Load sheet', html: '<html>sheet</html>' } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Courier pickups', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the pickups asked for, and prints the load sheet of one the courier took', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    const written: string[] = [];
    const tab = {
      document: {
        open: vi.fn(),
        write: (html: string) => written.push(html),
        close: vi.fn(),
        fonts: { ready: Promise.resolve() },
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderAdmin('/shop_1/shipping');

    fireEvent.click(await screen.findByRole('tab', { name: 'Pickups' }));
    const list = await screen.findByRole('list', { name: 'Pickups asked for' });
    const [taken, refused] = within(list).getAllByRole('listitem');
    expect(within(taken!).getByText('Courier is sending a rider')).toBeTruthy();
    expect(within(taken!).getByText('Parcels: 12')).toBeTruthy();
    expect(
      within(taken!).getByRole('link', { name: "PostEx's load sheet" }).getAttribute('href'),
    ).toBe('https://postex.example/sheet.pdf');
    expect(within(refused!).getByText('Leopards does not know rider R-9')).toBeTruthy();
    expect(within(refused!).queryByRole('button', { name: 'Print load sheet' })).toBeNull();

    fireEvent.click(within(taken!).getByRole('button', { name: 'Print load sheet' }));
    await waitFor(() => expect(tab.print).toHaveBeenCalled());
    expect(written).toEqual(['<html>sheet</html>']);
    expect(sentOf(fake, 'CourierLoadSheet')).toEqual([
      { accountId: 'acc_1', pickupId: 'pk_1', language: 'BILINGUAL' },
    ]);
  });

  it('asks a courier for a pickup, naming its rider where it asks, and says why one is refused', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping?tab=pickups');

    const ask = (await screen.findByRole('heading', { name: 'Ask for a pickup' })).parentElement!;
    const account = within(ask).getByLabelText('Courier account') as HTMLSelectElement;
    // A courier whose API takes no pickups is not offered.
    expect([...account.options].map((each) => each.value)).toEqual(['acc_1', 'acc_2']);
    expect(within(ask).queryByLabelText(/^Rider's name/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask PostEx for a pickup' }));
    expect(await screen.findByText('No parcels wait to be picked up')).toBeTruthy();

    fireEvent.change(account, { target: { value: 'acc_2' } });
    type("Rider's name", 'Imran');
    type("Rider's code", 'R-12');
    fireEvent.click(screen.getByRole('button', { name: 'Ask Leopards for a pickup' }));
    expect(
      await screen.findByText('Asked Leopards. Its answer shows below in a moment.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'CourierPickupRequest')).toEqual([
      { input: { accountId: 'acc_1' } },
      { input: { accountId: 'acc_2', riderName: 'Imran', riderCode: 'R-12' } },
    ]);
    expect(await screen.findByText('Asking the courier…')).toBeTruthy();
    expect(await screen.findByText('LS-4471', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('says when no courier of the shop takes pickups through its API', async () => {
    vi.stubGlobal('fetch', core([TRAX]).fetcher);
    renderAdmin('/shop_1/shipping?tab=pickups');
    expect(
      await screen.findByText(/^None of your couriers takes pickups through its API/),
    ).toBeTruthy();
  });

  it('checks off the parcels as the rider takes them, saying which, twice, or not in the pickup (ADR-377)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping?tab=pickups');

    const list = await screen.findByRole('list', { name: 'Pickups asked for' });
    // Only a pickup the courier took has parcels to hand over.
    expect(within(list).getAllByRole('button', { name: 'Check off by scanning' })).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: 'Check off by scanning' }));
    await screen.findByText('0 of 3 handed over');
    const left = () =>
      within(screen.getByRole('list', { name: 'Still to hand over' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    expect(left()).toEqual(['#1031PX100201', '#1032PX100202', '#1033PX100203']);

    const scan = async (code: string) => {
      type('Tracking number', code);
      fireEvent.click(screen.getByRole('button', { name: 'Check off' }));
    };
    await scan('px 100202');
    expect(await screen.findByText("#1032's parcel is handed over.")).toBeTruthy();
    await screen.findByText('1 of 3 handed over');
    expect(left()).toEqual(['#1031PX100201', '#1033PX100203']);
    expect(sentOf(fake, 'CourierPickupParcelHandOver')).toEqual([
      { pickupId: 'pk_1', trackingNumber: 'px 100202' },
    ]);
    await scan('PX100202');
    expect(await screen.findByText("#1032's parcel was checked off already.")).toBeTruthy();
    await scan('PX999999');
    expect(
      await screen.findByText('No parcel of this pickup has that tracking number'),
    ).toBeTruthy();

    await scan('PX100201');
    await screen.findByText("#1031's parcel is handed over.");
    await scan('PX100203');
    expect(await screen.findByText('All 3 parcels are handed over.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Still to hand over' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('3 of 3 handed over')).toBeNull());
  });

  it('records the parcels waiting as handed to a rider by hand, then checks them off (ADR-378)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/shipping?tab=pickups');

    const card = (await screen.findByRole('heading', { name: 'Hand parcels to a rider' }))
      .parentElement!;
    // Any courier account, those whose API takes pickups too.
    const account = within(card).getByLabelText('Courier account') as HTMLSelectElement;
    expect([...account.options].map((option) => option.text)).toEqual([
      'PostEx Lahore (PostEx)',
      'Leopards (Leopards)',
      'Trax (Trax)',
    ]);
    fireEvent.change(account, { target: { value: 'acc_3' } });
    fireEvent.change(within(card).getByLabelText("Rider's name (optional)"), {
      target: { value: ' Imran ' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Hand over the parcels waiting' }));

    // Its parcels are checked off at once.
    await screen.findByText('0 of 3 handed over');
    expect(sentOf(fake, 'CourierPickupRecordByHand')).toEqual([
      { input: { accountId: 'acc_3', riderName: 'Imran' } },
    ]);
    const list = screen.getByRole('list', { name: 'Pickups asked for' });
    expect(within(list).getByText('Handed to a rider by hand')).toBeTruthy();
    expect(sentOf(fake, 'CourierPickupParcels')).toEqual([{ id: 'pk_4' }]);
  });
});

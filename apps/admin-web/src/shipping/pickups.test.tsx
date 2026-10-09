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
    parcelCount: 0,
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
  return fakeCore('packer', (operation, variables) => {
    switch (operation) {
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

    const account = (await screen.findByLabelText('Courier account')) as HTMLSelectElement;
    // A courier whose API takes no pickups is not offered.
    expect([...account.options].map((each) => each.value)).toEqual(['acc_1', 'acc_2']);
    expect(screen.queryByLabelText(/^Rider's name/)).toBeNull();
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
});

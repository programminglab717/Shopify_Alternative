import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { DARAZ_SHOP_KEY } from './daraz-page';

const ACCOUNT = {
  account: 'zari@daraz.pk',
  sellerId: '7788',
  locationId: 'gid://hatti/Location/loc_1',
  syncPrices: false,
  syncedAt: null as string | null,
  lastError: null as string | null,
  connectedAt: '2026-10-28T05:00:00Z',
  leftOut: [] as { darazOrderId: string; error: string; at: string }[],
};

function core(
  role: StaffRole,
  options: { available?: boolean; account?: typeof ACCOUNT | null } = {},
) {
  let account: typeof ACCOUNT | null = options.account ?? null;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Daraz':
        return { daraz: { available: options.available ?? true, account } };
      case 'Locations':
        return {
          locations: {
            nodes: [
              { id: 'gid://hatti/Location/loc_1', name: 'Shop floor' },
              { id: 'gid://hatti/Location/loc_2', name: 'Warehouse' },
            ],
          },
        };
      case 'DarazConnectUrl':
        return {
          darazConnectUrl: `https://api.daraz.pk/oauth/authorize?state=s1&redirect_uri=${String(variables.redirectUri)}`,
        };
      case 'DarazConnect':
        if (variables.state !== 's1') {
          return {
            darazConnect: {
              account: null,
              userErrors: [
                {
                  field: ['state'],
                  code: 'INVALID',
                  message: 'This link to Daraz has ended: connect again',
                },
              ],
            },
          };
        }
        account = { ...ACCOUNT };
        return { darazConnect: { account, userErrors: [] } };
      case 'DarazAccountUpdate':
        account = { ...account!, ...(variables as Partial<typeof ACCOUNT>) };
        return { darazAccountUpdate: { account, userErrors: [] } };
      case 'DarazSync':
        account = { ...account!, syncedAt: '2026-10-28T06:00:00Z' };
        return { darazSync: { imported: 2, cancelled: 0, leftOut: 0, pushed: 5 } };
      case 'DarazDisconnect':
        account = null;
        return { darazDisconnect: true };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("A shop's Daraz account (CH-06, ADR-875)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is found in the settings', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/settings');
    fireEvent.click(await screen.findByRole('link', { name: /^Daraz/ }));
    expect(await screen.findByRole('heading', { name: 'Daraz' })).toBeTruthy();
  });

  it("sends the owner to Daraz's page, remembering the shop in this tab", async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as Location);
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/daraz');
    expect(await screen.findByText(/go to Daraz to let Hatti in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Daraz' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]![0])).toMatch(/^https:\/\/api\.daraz\.pk\/oauth\/authorize/);
    expect(sentOf(fake, 'DarazConnectUrl')).toEqual([
      { redirectUri: `${window.location.origin}/daraz/callback` },
    ]);
    expect(window.sessionStorage.getItem(DARAZ_SHOP_KEY)).toBe('shop_1');
  });

  it('says so where Daraz is not set up on Hatti, and offers nothing to press', async () => {
    vi.stubGlobal('fetch', core('owner', { available: false }).fetcher);
    renderAdmin('/shop_1/settings/daraz');
    expect(await screen.findByText('Daraz isn’t set up on Hatti yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Daraz' })).toBeNull();
  });

  it("connects with Daraz's code back in the shop that asked, once, the code then gone", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    window.sessionStorage.setItem(DARAZ_SHOP_KEY, 'shop_1');
    const { router } = renderAdmin('/daraz/callback?code=the-code&state=s1');
    expect(
      await screen.findByText('Daraz is connected. Its new orders come in from now on.'),
    ).toBeTruthy();
    expect(screen.getByText('Connected as zari@daraz.pk')).toBeTruthy();
    expect(sentOf(fake, 'DarazConnect')).toEqual([{ code: 'the-code', state: 's1' }]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1/settings/daraz'));
    expect(router.state.location.search).toEqual({});
    expect(window.sessionStorage.getItem(DARAZ_SHOP_KEY)).toBeNull();
  });

  it('says why a stale link to Daraz did not connect', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/daraz?code=the-code&state=old');
    expect(await screen.findByText('This link to Daraz has ended: connect again')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Daraz' })).toBeTruthy();
  });

  it('takes a callback with no shop remembered to the shops list', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    const { router } = renderAdmin('/daraz/callback?code=the-code&state=s1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/shops'));
  });

  it('sets where stock comes from and whether prices go, keeps in step on asking, and disconnects', async () => {
    const fake = core('owner', {
      account: {
        ...ACCOUNT,
        lastError: 'Daraz not reached',
        leftOut: [
          {
            darazOrderId: '9002',
            error: 'The shop has no active product with SKU NOT-HERE',
            at: '2026-10-28T05:30:00Z',
          },
        ],
      },
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/daraz');
    expect(await screen.findByText('Connected as zari@daraz.pk')).toBeTruthy();
    expect(screen.getByText('Not kept in step yet: it will be within minutes.')).toBeTruthy();
    expect(screen.getByText('The last try failed: Daraz not reached')).toBeTruthy();
    expect(screen.getByText('Daraz order 9002')).toBeTruthy();
    expect(screen.getByText('The shop has no active product with SKU NOT-HERE')).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('option', { name: 'Warehouse' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Stock and orders from'), {
      target: { value: 'gid://hatti/Location/loc_2' },
    });
    await waitFor(() =>
      expect(sentOf(fake, 'DarazAccountUpdate')).toEqual([
        { locationId: 'gid://hatti/Location/loc_2' },
      ]),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Give Daraz my prices too/ }));
    await waitFor(() =>
      expect(sentOf(fake, 'DarazAccountUpdate').at(-1)).toEqual({ syncPrices: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep in step now' }));
    expect(await screen.findByText('2 orders brought in, 5 SKUs updated on Daraz.')).toBeTruthy();
    expect(await screen.findByText(/^Last kept in step /)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect Daraz' })).toBeTruthy();
    expect(sentOf(fake, 'DarazDisconnect')).toHaveLength(1);
  });

  it('shows staff who may not change settings the account, without its buttons', async () => {
    vi.stubGlobal('fetch', core('accountant', { account: ACCOUNT }).fetcher);
    renderAdmin('/shop_1/settings/daraz');
    expect(await screen.findByText('Connected as zari@daraz.pk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep in step now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect((screen.getByLabelText('Stock and orders from') as HTMLSelectElement).disabled).toBe(
      true,
    );
  });
});

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const DETAILS = {
  shop: { brand: { logo: null, squareLogo: null } },
  onlineStorePreferences: { whatsappNumber: null },
};
const CLOSED = {
  id: 'shop_1',
  name: 'Zari',
  closedAt: '2026-10-22T09:00:00.000Z',
  deletesAt: '2027-01-20T09:00:00.000Z',
};

describe('Closing a shop and reopening it (ADR-740)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('closes it for its owner once they type its name, then offers to reopen it until its data goes', async () => {
    const account: Parameters<typeof fakeCore>[3] & { closedShops?: (typeof CLOSED)[] } = {};
    const core = fakeCore(
      'owner',
      (operation) => {
        if (operation === 'ShopDetails') return DETAILS;
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/shops/shop_1/close') {
          account.closedShops = [CLOSED];
          return { shop: CLOSED };
        }
        if (path === '/auth/shops/shop_1/reopen') {
          account.closedShops = [];
          return { shop: { id: 'shop_1', name: 'Zari', role: 'owner', mfaRequired: true } };
        }
        return {};
      },
      account,
    );
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/settings/shop');

    const card = (await screen.findByRole('heading', { name: 'Close this shop' })).closest('form')!;
    const close = within(card).getByRole('button', { name: 'Close the shop' }) as HTMLButtonElement;
    // Its name, as it is, before anything is sent.
    expect(close.disabled).toBe(true);
    type('Type Zari to close it', 'Zar');
    expect(close.disabled).toBe(true);
    type('Type Zari to close it', 'Zari');
    await press('Close the shop');
    await waitFor(() => expect(router.state.location.pathname).toBe('/shops'));
    expect(core.sent.find((each) => each.operation === '/auth/shops/shop_1/close')).toEqual({
      operation: '/auth/shops/shop_1/close',
      method: 'POST',
      variables: { name: 'Zari' },
    });

    // On their shops, with the day its data goes, to reopen.
    const closed = await screen.findByRole('region', { name: 'Closed shops' });
    expect(closed.textContent).toContain('Zari');
    expect(closed.textContent).toContain('Its data is deleted on 20 Jan 2027');
    fireEvent.click(within(closed).getByRole('button', { name: 'Reopen Zari' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1'));
    expect(core.sent.some((each) => each.operation === '/auth/shops/shop_1/reopen')).toBe(true);
  });

  it("is not offered to the shop's staff", async () => {
    const core = fakeCore('manager', (operation) => {
      if (operation === 'ShopDetails') return DETAILS;
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/shop');
    await screen.findByLabelText('WhatsApp number');
    expect(screen.queryByRole('heading', { name: 'Close this shop' })).toBeNull();
  });
});

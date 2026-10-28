import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, presetAccess, renderAdmin, signedIn } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** An account of three shops: Zari and Khussa Ghar its own, and one where it packs alone. */
function threeShops() {
  const core = fakeCore('owner', () => {
    throw new Error('unexpected');
  });
  const glance = (sales: string, orders: number, toConfirm: number, toPack: number) => ({
    data: {
      home: {
        toConfirm: { count: toConfirm },
        toPack: { count: toPack },
        today: { sales: { count: orders, total: pkr(sales) } },
      },
    },
  });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/me') {
      return json({
        session: { id: 'ses_1', mfaVerified: true },
        user: { id: 'usr_1', name: 'Sana', language: 'en' },
        shops: [
          presetAccess('owner'),
          { ...presetAccess('owner'), id: 'shop_2', name: 'Khussa Ghar' },
          { ...presetAccess('packer'), id: 'shop_3', name: 'Lawn Bazaar' },
        ],
      });
    }
    if (String(init?.body ?? '').includes('query ShopGlance')) {
      const shop = new Headers(init!.headers).get('x-hatti-shop-id');
      if (shop === 'shop_1') return json(glance('45000.00', 12, 3, 5));
      if (shop === 'shop_2') return json(glance('5500.00', 2, 1, 0));
      return json({
        data: null,
        errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
      });
    }
    return core.fetcher(path, init);
  });
  return fetcher;
}

describe("The account's shops at a glance (ADM-06, ADR-841)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each shop's sales today and what waits, and what they come to together", async () => {
    vi.stubGlobal('fetch', threeShops());
    renderAdmin('/');

    const totals = await screen.findByRole('region', { name: 'Today across your shops' });
    expect(await within(totals).findByText('Rs 50,500')).toBeTruthy();
    expect(within(totals).getByText('sales today, 14 orders')).toBeTruthy();
    expect(within(totals).getByText('4')).toBeTruthy();
    expect(within(totals).getByText('5')).toBeTruthy();
    expect(screen.getByText('Rs 45,000 today · 3 to confirm · 5 to pack')).toBeTruthy();
    expect(screen.getByText('Rs 5,500 today · 1 to confirm · 0 to pack')).toBeTruthy();
    // The shop whose orders the member can't read says nothing of them.
    const lawn = screen.getByText('Lawn Bazaar').closest('a')!;
    expect(within(lawn).queryByText(/today ·/)).toBeNull();
  });
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, presetAccess, renderAdmin, signedIn, type } from '../test-support';

function core(role: StaffRole = 'owner') {
  let stores: Record<string, unknown>[] = [];
  const fake = fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ExpansionStores':
        return { expansionStores: stores };
      case 'ExpansionStoreSave': {
        const made = {
          shopId: variables.shopId,
          name: 'Zari Abroad',
          currencyCode: 'USD',
          priceRate: variables.priceRate,
          copiedAt: null,
          lastCopy: null,
          autoCopy: false,
          copyError: null,
          copyFailedAt: null,
          followRate: false,
        };
        stores = [made];
        return { expansionStoreSave: { expansionStore: made, userErrors: [] } };
      }
      case 'ExpansionStoreCopy':
        stores = stores.map((each) => ({
          ...each,
          copiedAt: '2026-10-28T09:00:00Z',
          lastCopy: { created: 12, updated: 3, problems: 1 },
        }));
        return { expansionStoreCopy: { expansionStore: stores[0], userErrors: [] } };
      case 'ExpansionStoreAutoCopySet':
        // As the worker would leave it, a copy having failed since.
        stores = stores.map((each) => ({
          ...each,
          autoCopy: variables.enabled,
          copyError: 'The same person no longer owns both shops',
          copyFailedAt: '2026-10-28T10:00:00Z',
        }));
        return { expansionStoreAutoCopySet: { expansionStore: stores[0], userErrors: [] } };
      case 'ExpansionStoreFollowRateSet':
        // The day's rate from rupees to dollars, as the core would take it.
        stores = stores.map((each) => ({
          ...each,
          followRate: variables.enabled,
          priceRate: variables.enabled ? '0.00357' : each.priceRate,
        }));
        return { expansionStoreFollowRateSet: { expansionStore: stores[0], userErrors: [] } };
      case 'ExpansionStoreSales':
        // This shop's sales, and its store's in dollars and at the day's rate in rupees.
        return {
          expansionStoreSales: [
            {
              shopId: 'shop_1',
              name: 'Zari',
              here: true,
              currencyCode: 'PKR',
              orders: 12,
              totalSales: { amount: '60000.00', currencyCode: 'PKR' },
              totalSalesHere: { amount: '60000.00', currencyCode: 'PKR' },
            },
            {
              shopId: 'shop_2',
              name: 'Zari Abroad',
              here: false,
              currencyCode: 'USD',
              orders: 3,
              totalSales: { amount: '150.00', currencyCode: 'USD' },
              totalSalesHere: { amount: '42000.00', currencyCode: 'PKR' },
            },
          ],
        };
      case 'ExpansionStoreRemove':
        stores = [];
        return { expansionStoreRemove: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
  // The member owns another shop besides this one.
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/auth/me') {
      return new Response(
        JSON.stringify({
          session: { id: 'ses_1', mfaVerified: true },
          shops: [
            presetAccess(role),
            { ...presetAccess('owner'), id: 'shop_2', name: 'Zari Abroad' },
          ],
          user: { id: 'usr_1', name: 'Sana', language: 'en' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return fake.fetcher(path, init);
  });
  return { ...fake, fetcher };
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Expansion stores (CH-11, ADR-859)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("links the owner's other shop at a rate, copies to it, and stops", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Expansion stores/ }));
    expect(await screen.findByText('No expansion store yet.')).toBeTruthy();
    expect((screen.getByLabelText('Shop') as HTMLSelectElement).value).toBe('shop_2');
    type('Price rate', '0.0036');
    fireEvent.click(screen.getByRole('button', { name: 'Add the expansion store' }));
    expect(await screen.findByText('0.0036 USD for each PKR')).toBeTruthy();
    expect(sentOf(fake, 'ExpansionStoreSave')).toEqual([{ shopId: 'shop_2', priceRate: '0.0036' }]);
    expect(screen.getByText('Not copied yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy products to Zari Abroad' }));
    expect(await screen.findByText(/: 12 made, 3 updated, 1 not taken\.$/)).toBeTruthy();

    // Copied as products change, and told when that failed (ADR-913).
    const auto = screen.getByLabelText(
      'Copy to Zari Abroad as products change, within the hour',
    ) as HTMLInputElement;
    expect(auto.checked).toBe(false);
    fireEvent.click(auto);
    expect(
      await screen.findByText(/The same person no longer owns both shops\. It is tried again/),
    ).toBeTruthy();
    expect(sentOf(fake, 'ExpansionStoreAutoCopySet')).toEqual([
      { shopId: 'shop_2', enabled: true },
    ]);

    // The price rate follows the day's rate between the currencies (ADR-929).
    const follow = screen.getByLabelText(
      "Follow the day's rate from PKR to USD",
    ) as HTMLInputElement;
    expect(follow.checked).toBe(false);
    fireEvent.click(follow);
    expect(await screen.findByText('0.00357 USD for each PKR')).toBeTruthy();
    expect(sentOf(fake, 'ExpansionStoreFollowRateSet')).toEqual([
      { shopId: 'shop_2', enabled: true },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Stop copying to Zari Abroad' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStoreRemove')).toEqual([{ shopId: 'shop_2' }]),
    );
    expect(await screen.findByText('No expansion store yet.')).toBeTruthy();
  });

  it("shows each store's sales on one page, and all of them together in rupees (ADR-932)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/expansion-stores');
    await screen.findByLabelText('Price rate');
    type('Price rate', '0.0036');
    fireEvent.click(await screen.findByRole('button', { name: 'Add the expansion store' }));
    expect(await screen.findByRole('heading', { name: 'Sales across your stores' })).toBeTruthy();
    expect(await screen.findByText('Zari (this shop)')).toBeTruthy();
    expect(screen.getByText('3 orders · USD 150')).toBeTruthy();
    expect(screen.getByText('≈ Rs 42,000 at the day’s rate')).toBeTruthy();
    expect(screen.getByText('All your stores: Rs 102,000')).toBeTruthy();
    // Over the last 30 days unless another period is picked.
    const [asked] = sentOf(fake, 'ExpansionStoreSales') as { from: string; before: string }[];
    const days = (Date.parse(asked!.before) - Date.parse(asked!.from)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7' } });
    await waitFor(() => expect(sentOf(fake, 'ExpansionStoreSales').length).toBe(2));
  });

  it('is kept by the owner alone', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/settings');
    await screen.findByRole('link', { name: /Apps/ });
    expect(screen.queryByRole('link', { name: /Expansion stores/ })).toBeNull();
  });
});

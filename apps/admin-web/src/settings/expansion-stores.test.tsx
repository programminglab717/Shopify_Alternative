import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, presetAccess, renderAdmin, signedIn, type } from '../test-support';

/** A day's sales in rupees, from midnight in Karachi. */
const day = (date: string, amount: string) => ({
  start: `${date}T00:00:00+05:00`,
  totalSalesHere: { amount, currencyCode: 'PKR' },
});

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
          marginPercent: 0,
          rounding: 'exact',
          collectionMargins: [],
          productMargins: [],
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
      case 'Collections':
        return {
          collections: {
            nodes: [
              { id: 'col_1', title: 'Lawn', productsCount: 12, ruleSet: null },
              { id: 'col_2', title: 'Furniture', productsCount: 4, ruleSet: null },
            ],
          },
        };
      case 'ExpansionStoreCollectionMarginsSet': {
        const titles: Record<string, string> = { col_1: 'Lawn', col_2: 'Furniture' };
        const margins = variables.margins as { collectionId: string; marginPercent: number }[];
        stores = stores.map((each) => ({
          ...each,
          collectionMargins: margins.map((margin) => ({
            ...margin,
            collectionTitle: titles[margin.collectionId],
          })),
        }));
        return {
          expansionStoreCollectionMarginsSet: { expansionStore: stores[0], userErrors: [] },
        };
      }
      case 'Products':
        // The search for a product to give a margin of its own (ADR-960).
        return {
          products: {
            nodes: [
              { id: 'prod_1', title: 'Teak sofa' },
              { id: 'prod_2', title: 'Silk scarf' },
            ].filter((product) =>
              product.title.toLowerCase().includes(String(variables.query).toLowerCase()),
            ),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'ExpansionStoreProductMarginsSet': {
        const titles: Record<string, string> = { prod_1: 'Teak sofa', prod_2: 'Silk scarf' };
        const margins = variables.margins as { productId: string; marginPercent: number }[];
        stores = stores.map((each) => ({
          ...each,
          productMargins: margins.map((margin) => ({
            ...margin,
            productTitle: titles[margin.productId],
          })),
        }));
        return {
          expansionStoreProductMarginsSet: { expansionStore: stores[0], userErrors: [] },
        };
      }
      case 'ExpansionStorePricingSet':
        stores = stores.map((each) => ({
          ...each,
          marginPercent: variables.marginPercent,
          rounding: variables.rounding,
        }));
        return { expansionStorePricingSet: { expansionStore: stores[0], userErrors: [] } };
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
              periods: [day('2026-10-27', '25000.00'), day('2026-10-28', '35000.00')],
            },
            {
              shopId: 'shop_2',
              name: 'Zari Abroad',
              here: false,
              currencyCode: 'USD',
              orders: 3,
              totalSales: { amount: '150.00', currencyCode: 'USD' },
              totalSalesHere: { amount: '42000.00', currencyCode: 'PKR' },
              periods: [day('2026-10-27', '0.00'), day('2026-10-28', '42000.00')],
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

    // Its prices 10% over the rate, rounded up to .99 (ADR-933).
    type('Margin over the rate (%)', '10');
    fireEvent.change(screen.getByLabelText('Rounding'), { target: { value: 'ninety_nine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for Zari Abroad' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStorePricingSet')).toEqual([
        { shopId: 'shop_2', marginPercent: 10, rounding: 'ninety_nine' },
      ]),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop copying to Zari Abroad' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStoreRemove')).toEqual([{ shopId: 'shop_2' }]),
    );
    expect(await screen.findByText('No expansion store yet.')).toBeTruthy();
  });

  it("gives a collection's products a margin of their own, the first of a product's (ADR-948)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/expansion-stores');
    await screen.findByLabelText('Price rate');
    type('Price rate', '0.0036');
    fireEvent.click(await screen.findByRole('button', { name: 'Add the expansion store' }));
    const add = await screen.findByRole('button', { name: 'Add a collection' });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: 'Add a collection' }));
    // Two rows: Lawn first, then Furniture, each collection once.
    const [first, second] = screen.getAllByLabelText('Collection') as HTMLSelectElement[];
    expect([first!.value, second!.value]).toEqual(['col_1', 'col_2']);
    fireEvent.change(second!, { target: { value: 'col_2' } });
    const [lawn, furniture] = screen.getAllByLabelText("Margin for the collection's products (%)");
    fireEvent.change(lawn!, { target: { value: '5' } });
    fireEvent.change(furniture!, { target: { value: '40' } });
    // Both collections given: no third to add.
    expect(screen.queryByRole('button', { name: 'Add a collection' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the margin of Lawn' }));
    fireEvent.click(
      screen.getByRole('button', { name: "Save Zari Abroad's margins by collection" }),
    );
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStoreCollectionMarginsSet')).toEqual([
        { shopId: 'shop_2', margins: [{ collectionId: 'col_2', marginPercent: 40 }] },
      ]),
    );
  });

  it('gives a product found by a search a margin of its own (ADR-960)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/expansion-stores');
    await screen.findByLabelText('Price rate');
    type('Price rate', '0.0036');
    fireEvent.click(await screen.findByRole('button', { name: 'Add the expansion store' }));
    fireEvent.change(await screen.findByLabelText('Find a product'), {
      target: { value: 'sofa' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Give Teak sofa a margin' }));
    // Given one, it is offered no more.
    expect(screen.queryByRole('button', { name: 'Give Teak sofa a margin' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Margin for Teak sofa (%)'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: "Save Zari Abroad's product margins" }));
    await waitFor(() =>
      expect(sentOf(fake, 'ExpansionStoreProductMarginsSet')).toEqual([
        { shopId: 'shop_2', margins: [{ productId: 'prod_1', marginPercent: 45 }] },
      ]),
    );
    // Searched as typed, ten at most.
    expect(sentOf(fake, 'Products')[0]).toEqual({ first: 10, query: 'sofa' });
  });

  it("shows each store's sales on one page, and all of them together in rupees (ADR-932)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/expansion-stores');
    await screen.findByLabelText('Price rate');
    type('Price rate', '0.0036');
    fireEvent.click(await screen.findByRole('button', { name: 'Add the expansion store' }));
    expect(await screen.findByRole('heading', { name: 'Sales across your stores' })).toBeTruthy();
    // In the list, and in the chart's key (ADR-955).
    expect(await screen.findAllByText('Zari (this shop)')).toHaveLength(2);
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

  it("draws each store's part of each day's sales in rupees, and each week's over 90 days (ADR-955)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/expansion-stores');
    await screen.findByLabelText('Price rate');
    type('Price rate', '0.0036');
    fireEvent.click(await screen.findByRole('button', { name: 'Add the expansion store' }));
    const chart = await screen.findByRole('list', { name: 'Sales by day, at the day’s rate' });
    const bars = within(chart).getAllByRole('listitem');
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/: Rs 25,000$/),
      expect.stringMatching(/: Rs 77,000$/),
    ]);
    // The first day this shop's alone; the second both stores', each a part of the bar.
    expect(bars[0]!.children).toHaveLength(1);
    expect(bars[1]!.children).toHaveLength(2);
    expect(screen.getAllByText('Zari Abroad').length).toBeGreaterThan(0);
    const [asked] = sentOf(fake, 'ExpansionStoreSales') as { interval: string }[];
    expect(asked!.interval).toBe('DAY');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '90' } });
    expect(
      await screen.findByRole('list', { name: 'Sales by week, at the day’s rate' }),
    ).toBeTruthy();
    expect((sentOf(fake, 'ExpansionStoreSales').at(-1) as { interval: string }).interval).toBe(
      'WEEK',
    );
  });

  it('is kept by the owner alone', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/settings');
    await screen.findByRole('link', { name: /Apps/ });
    expect(screen.queryByRole('link', { name: /Expansion stores/ })).toBeNull();
  });
});

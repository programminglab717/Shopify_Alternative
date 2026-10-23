import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceListPriceValue, PriceListValue } from '../api/types';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';
import { listInput, variantName } from './price-lists-page';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

const WHOLESALE: PriceListValue = {
  id: 'plst_1',
  name: 'Wholesale',
  customerTag: 'wholesale',
  percentOff: '20',
  quantityBreaks: [{ minQuantity: 12, percentOff: '5' }],
  pricedVariants: 2,
  updatedAt: '2026-10-20T09:00:00Z',
};

const PRICES: PriceListPriceValue[] = [
  {
    variantId: 'var_kurta',
    price: pkr('1500.00'),
    productTitle: 'Kurta',
    variantTitle: 'Red / M',
    retailPrice: pkr('2000.00'),
  },
  {
    variantId: 'var_lawn',
    price: pkr('1800.00'),
    productTitle: 'Lawn suit',
    variantTitle: null,
    retailPrice: pkr('3000.00'),
  },
];

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A fake core keeping the shop's price lists and the wholesale list's prices as the core would. */
function priceListsCore() {
  let lists: PriceListValue[] = [copy(WHOLESALE)];
  let prices: PriceListPriceValue[] = copy(PRICES);
  return fakeCore('owner', (operation, variables) => {
    const input = (variables?.input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case 'PriceLists':
        return { priceLists: lists };
      case 'PriceListCreate': {
        if (String(input.customerTag).toLowerCase() === 'wholesale') {
          return {
            priceListCreate: {
              priceList: null,
              userErrors: [
                {
                  field: ['input', 'customerTag'],
                  code: 'TAKEN',
                  message: 'Another price list is for customers with this tag',
                },
              ],
            },
          };
        }
        const made: PriceListValue = {
          ...copy(WHOLESALE),
          id: 'plst_2',
          name: String(input.name),
          customerTag: String(input.customerTag),
          percentOff: String(input.percentOff),
          quantityBreaks: input.quantityBreaks as PriceListValue['quantityBreaks'],
          pricedVariants: 0,
        };
        lists = [...lists, made];
        return { priceListCreate: { priceList: made, userErrors: [] } };
      }
      case 'PriceListDelete':
        lists = lists.filter((each) => each.id !== variables.id);
        return { priceListDelete: { deletedPriceListId: variables.id, userErrors: [] } };
      case 'PriceListPrices':
        return { priceListPrices: prices };
      case 'DraftVariants':
        return {
          products: {
            nodes: [
              {
                id: 'prd_shawl',
                title: 'Shawl',
                variants: [
                  {
                    id: 'var_shawl',
                    title: 'Default Title',
                    availableForSale: true,
                    inventoryQuantity: 9,
                    price: pkr('2500.00'),
                  },
                ],
              },
            ],
          },
        };
      case 'PriceListPricesSet': {
        const sent = variables.prices as { variantId: string; price: string | null }[];
        prices = prices.filter((each) => !sent.some((one) => one.variantId === each.variantId));
        for (const each of sent) {
          if (each.price === null) continue;
          const was = PRICES.find((one) => one.variantId === each.variantId);
          prices.push({
            variantId: each.variantId,
            price: pkr(`${each.price}.00`),
            productTitle: was?.productTitle ?? 'Shawl',
            variantTitle: was?.variantTitle ?? null,
            retailPrice: was?.retailPrice ?? pkr('2500.00'),
          });
        }
        return { priceListPricesSet: { prices, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof priceListsCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Price lists in the admin (CUS-06, ADR-779)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a list as the API takes it, and names variants as the admin shows them', () => {
    expect(
      listInput({
        name: 'Retailers',
        customerTag: 'retail',
        percentOff: ' ',
        breaks: [
          { minQuantity: '24', percentOff: '7.5 ' },
          { minQuantity: 'six', percentOff: '10' },
        ],
      }),
    ).toEqual({
      name: 'Retailers',
      customerTag: 'retail',
      percentOff: '0',
      quantityBreaks: [
        { minQuantity: 24, percentOff: '7.5' },
        { minQuantity: 0, percentOff: '10' },
      ],
    });
    expect(variantName(PRICES[0]!)).toBe('Kurta · Red / M');
    expect(variantName(PRICES[1]!)).toBe('Lawn suit');
  });

  it('shows each list with what it takes off, refuses a tag another list has, and adds one', async () => {
    const core = priceListsCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/price-lists');

    const card = (await screen.findByRole('heading', { name: 'Wholesale' })).closest('li')!;
    expect(within(card).getByText('For customers tagged wholesale')).toBeTruthy();
    expect(within(card).getByText('20% off everything')).toBeTruthy();
    expect(within(card).getByText('5% more off from 12 units')).toBeTruthy();
    expect(within(card).getByText('2 variants with a price of their own')).toBeTruthy();

    type('Name', 'Retailers');
    type('Customer tag', 'WHOLESALE');
    await press('Add price list');
    await screen.findByText(/Another price list is for customers with this tag/);

    type('Customer tag', 'retail');
    type('Off everything (%)', '5');
    await press('Add a break');
    type('From (units)', '24');
    type('Further off (%)', '7.5');
    await press('Add price list');
    await screen.findByRole('heading', { name: 'Retailers' });
    expect(sentOf(core, 'PriceListCreate').at(-1)).toEqual({
      input: {
        name: 'Retailers',
        customerTag: 'retail',
        percentOff: '5',
        quantityBreaks: [{ minQuantity: 24, percentOff: '7.5' }],
      },
    });
  });

  it("changes a list's own prices, takes one out, adds a variant, and deletes the list", async () => {
    const core = priceListsCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/price-lists');

    const card = (await screen.findByRole('heading', { name: 'Wholesale' })).closest('li')!;
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Prices of its own' })),
    );
    const kurta = await within(card).findByLabelText('Price of Kurta · Red / M');
    expect((kurta as HTMLInputElement).value).toBe('1500');
    expect(within(card).getByText('Rs 3,000 to anyone', { exact: false })).toBeTruthy();

    fireEvent.change(kurta, { target: { value: '1400' } });
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Take Lawn suit out of the list' })),
    );
    await press('Add variants');
    type('Find products by name or SKU', 'shawl');
    await press('Find');
    await act(async () =>
      fireEvent.click(await screen.findByRole('button', { name: /Add Shawl/ })),
    );
    fireEvent.change(within(card).getByLabelText('Price of Shawl'), { target: { value: '2000' } });
    await press('Save prices');
    await within(card).findByText('Saved');
    expect(sentOf(core, 'PriceListPricesSet').at(-1)).toEqual({
      id: 'plst_1',
      prices: [
        { variantId: 'var_kurta', price: '1400' },
        { variantId: 'var_shawl', price: '2000' },
        { variantId: 'var_lawn', price: null },
      ],
    });
    expect(within(card).queryByLabelText('Price of Lawn suit')).toBeNull();

    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Delete' })));
    await press('Yes, delete');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Wholesale' })).toBeNull());
    expect(sentOf(core, 'PriceListDelete')).toEqual([{ id: 'plst_1' }]);
  });
});

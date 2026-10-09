import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };

interface Item {
  id: string;
  tracked: boolean;
  inventoryPolicy: 'CONTINUE' | 'DENY';
}

function variant(id: string, title: string, item: Item) {
  return {
    id,
    title,
    price: { amount: '3200.00', currencyCode: 'PKR' },
    compareAtPrice: null,
    sku: null,
    taxCode: null,
    selectedOptions: title === 'Default Title' ? [] : [{ name: 'Size', value: title }],
    inventoryQuantity: 4,
    inventoryItem: {
      ...item,
      inventoryLevels: item.tracked ? [{ available: 4, location: { id: LOCATION.id } }] : [],
    },
  };
}

/** A fake core with a kurta, in sizes or alone, whose items change as the page asks. */
function core(role: StaffRole, sizes: boolean) {
  let items: Record<string, Item> = sizes
    ? {
        var_s: { id: 'item_s', tracked: true, inventoryPolicy: 'DENY' },
        var_m: { id: 'item_m', tracked: true, inventoryPolicy: 'DENY' },
      }
    : { var_1: { id: 'item_1', tracked: false, inventoryPolicy: 'DENY' } };
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: LOCATION,
          product: {
            id: 'prod_1',
            title: 'Khaddar Kurta',
            description: '',
            handle: 'khaddar-kurta',
            status: 'ACTIVE',
            productType: null,
            vendor: null,
            tags: [],
            totalInventory: 8,
            tracksInventory: true,
            options: sizes
              ? [
                  {
                    id: 'opt_1',
                    name: 'Size',
                    optionValues: [
                      { id: 'ov_s', name: 'S' },
                      { id: 'ov_m', name: 'M' },
                    ],
                  },
                ]
              : [],
            media: [],
            variants: sizes
              ? [variant('var_s', 'S', items.var_s!), variant('var_m', 'M', items.var_m!)]
              : [variant('var_1', 'Default Title', items.var_1!)],
          },
        };
      case 'InventoryItemUpdate': {
        const input = variables.input as Partial<Item>;
        if (input.inventoryPolicy === 'CONTINUE' && variables.id === 'item_m') {
          return {
            inventoryItemUpdate: {
              inventoryItem: null,
              userErrors: [
                { field: ['input'], code: 'INVALID', message: 'M is sold through a marketplace' },
              ],
            },
          };
        }
        items = Object.fromEntries(
          Object.entries(items).map(([key, item]) => [
            key,
            item.id === variables.id ? { ...item, ...input } : item,
          ]),
        );
        return { inventoryItemUpdate: { inventoryItem: null, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("A product's stock rules", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps one size selling when out of stock, stops counting another, and names a refusal', async () => {
    const fake = core('owner', true);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const rules = await screen.findByRole('region', { name: 'Stock rules' });
    const keepS = within(rules).getByLabelText(/^Keep selling S when out of stock/);
    expect((keepS as HTMLInputElement).checked).toBe(false);
    fireEvent.click(keepS);
    expect(
      await within(rules).findByLabelText(/^Keep selling S when out of stock/, {
        selector: 'input:checked',
      }),
    ).toBeTruthy();

    fireEvent.click(within(rules).getByLabelText(/^Keep selling M when out of stock/));
    expect(await within(rules).findByText('M is sold through a marketplace')).toBeTruthy();

    fireEvent.click(within(rules).getByLabelText(/^Count the stock of M/));
    // Not counted, it has no stock to run out of.
    await within(rules).findByLabelText(/^Count the stock of M/, {
      selector: 'input:not(:checked)',
    });
    expect(within(rules).queryByLabelText(/^Keep selling M when out of stock/)).toBeNull();
    expect(sentOf(fake, 'InventoryItemUpdate')).toEqual([
      { id: 'item_s', input: { inventoryPolicy: 'CONTINUE' } },
      { id: 'item_m', input: { inventoryPolicy: 'CONTINUE' } },
      { id: 'item_m', input: { tracked: false } },
    ]);
  });

  it('counts the stock of a product sold as it is', async () => {
    const fake = core('manager', false);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const rules = await screen.findByRole('region', { name: 'Stock rules' });
    expect(within(rules).queryByLabelText(/^Keep selling when out of stock/)).toBeNull();
    fireEvent.click(within(rules).getByLabelText(/^Count its stock/));
    expect(await within(rules).findByLabelText(/^Keep selling when out of stock/)).toBeTruthy();
    expect(sentOf(fake, 'InventoryItemUpdate')).toEqual([
      { id: 'item_1', input: { tracked: true } },
    ]);
  });

  it('is not there for a packer', async () => {
    vi.stubGlobal('fetch', core('packer', true).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByRole('heading', { name: 'Khaddar Kurta' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Stock rules' })).toBeNull();
  });
});

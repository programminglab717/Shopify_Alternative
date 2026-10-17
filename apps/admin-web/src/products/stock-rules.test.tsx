import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };

interface Item {
  id: string;
  tracked: boolean;
  inventoryPolicy: 'CONTINUE' | 'DENY';
  harmonizedSystemCode?: string | null;
}

const NOT_HS = 'must be an HS code of 6 to 13 digits, as "6204.42.00"';

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
    // The small sold six in 30 days: its four for sale last 20 more (ADR-370).
    soldLast30Days: id === 'var_s' ? 6 : 0,
    daysOfStockLeft: id === 'var_s' ? 20 : null,
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
        var_s: {
          id: 'item_s',
          tracked: true,
          inventoryPolicy: 'DENY',
          harmonizedSystemCode: '62034200',
        },
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
        // A copy: the variables sent are kept as they were.
        const input = { ...(variables.input as Partial<Item>) };
        if (input.harmonizedSystemCode !== undefined) {
          // As the core keeps it: digits, or none.
          const digits = (input.harmonizedSystemCode ?? '').replace(/[\s.]/g, '');
          if (digits && !/^[0-9]{6,13}$/.test(digits)) {
            return {
              inventoryItemUpdate: {
                inventoryItem: null,
                userErrors: [
                  { field: ['input', 'harmonizedSystemCode'], code: 'INVALID', message: NOT_HS },
                ],
              },
            };
          }
          input.harmonizedSystemCode = digits || null;
        }
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
        const kept = Object.values(items).find((item) => item.id === variables.id);
        return {
          inventoryItemUpdate: {
            inventoryItem: { harmonizedSystemCode: kept?.harmonizedSystemCode ?? null },
            userErrors: [],
          },
        };
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
    // How fast each size sells, beside its name; the one that sold none says nothing.
    expect(screen.getByText('6 sold in 30 days · lasts about 20 days')).toBeTruthy();
    expect(screen.getAllByText(/sold in 30 days/)).toHaveLength(1);
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

  it("keeps each size's HS code as digits, names one that is not, and clears one (ADR-559)", async () => {
    const fake = core('owner', true);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const rules = await screen.findByRole('region', { name: 'Stock rules' });
    const field = (size: string) =>
      within(rules).getByLabelText(`HS code of ${size}`) as HTMLInputElement;
    expect(field('S').value).toBe('62034200');
    expect(field('M').value).toBe('');
    // Left as it was, nothing is sent.
    fireEvent.blur(field('S'));

    fireEvent.change(field('M'), { target: { value: 'cotton' } });
    fireEvent.blur(field('M'));
    expect(await within(rules).findByText(NOT_HS)).toBeTruthy();
    expect(field('M').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(field('M'), { target: { value: '6204.42.00' } });
    fireEvent.blur(field('M'));
    await waitFor(() => expect(field('M').value).toBe('62044200'));
    expect(within(rules).queryByText(NOT_HS)).toBeNull();

    fireEvent.change(field('S'), { target: { value: '' } });
    fireEvent.blur(field('S'));
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryItemUpdate')).toEqual([
        { id: 'item_m', input: { harmonizedSystemCode: 'cotton' } },
        { id: 'item_m', input: { harmonizedSystemCode: '6204.42.00' } },
        { id: 'item_s', input: { harmonizedSystemCode: '' } },
      ]),
    );
    await waitFor(() => expect(field('S').value).toBe(''));
  });

  it('asks a product without sizes for its HS code', async () => {
    vi.stubGlobal('fetch', core('manager', false).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    const rules = await screen.findByRole('region', { name: 'Stock rules' });
    expect((within(rules).getByLabelText('HS code') as HTMLInputElement).value).toBe('');
  });

  it('is not there for a packer', async () => {
    vi.stubGlobal('fetch', core('packer', true).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(await screen.findByRole('heading', { name: 'Khaddar Kurta' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Stock rules' })).toBeNull();
  });
});

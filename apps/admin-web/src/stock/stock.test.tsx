import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });
const MAIN = { id: 'loc_1', name: 'Main warehouse' };

const level = (onHand: number, committed: number) => ({
  id: 'lvl_1',
  available: onHand - committed,
  onHand,
  committed,
  reserved: 0,
  safetyStock: 0,
  location: MAIN,
});

function item(id: string) {
  if (id === 'inv_3') {
    return {
      location: MAIN,
      inventoryItem: {
        id,
        tracked: false,
        inventoryLevels: [],
        changes: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
  }
  return {
    location: MAIN,
    inventoryItem: {
      id,
      tracked: true,
      inventoryLevels: [level(4, 2)],
      changes: {
        nodes: [
          {
            createdAt: LATER,
            delta: -1,
            name: 'committed',
            reason: 'committed',
            quantityAfterChange: 2,
            referenceDocumentUri: 'hatti://orders/ord_1',
            location: MAIN,
          },
          {
            createdAt: LATER,
            delta: 10,
            name: 'on_hand',
            reason: 'received',
            quantityAfterChange: 10,
            referenceDocumentUri: null,
            location: MAIN,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

const SHOP = { id: 'loc_2', name: 'Gulberg shop' };

function core(role: StaffRole, places = [MAIN, SHOP]) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Locations':
        return {
          locations: {
            nodes: places.map((place) => ({ ...place, isPrimary: place.id === MAIN.id })),
          },
        };
      case 'InventoryMove':
        return { inventoryMoveQuantities: { userErrors: [] } };
      case 'LowStock':
        return {
          inventorySettings: { lowStockThreshold: 5 },
          inventoryLowStock: {
            nodes: [
              {
                variantId: 'var_1',
                variantTitle: 'M',
                productId: 'prod_1',
                productTitle: 'Lawn suit',
                sku: 'LS-M',
                available: 0,
                inventoryItem: { id: 'inv_1' },
              },
              {
                variantId: 'var_2',
                variantTitle: 'Default Title',
                productId: 'prod_2',
                productTitle: 'Dupatta',
                sku: null,
                available: 2,
                inventoryItem: { id: 'inv_2' },
              },
            ],
          },
        };
      case 'InventoryItem':
        return item(variables.id as string);
      case 'StockSearch':
        return {
          products: {
            nodes: [
              {
                id: 'prod_3',
                title: 'Khussa',
                variants: [
                  {
                    id: 'var_3',
                    title: 'Default Title',
                    sku: null,
                    inventoryQuantity: 0,
                    inventoryItem: { id: 'inv_3', tracked: false },
                  },
                ],
              },
            ],
          },
        };
      case 'InventoryAdjust':
        return { inventoryAdjustQuantities: { userErrors: [] } };
      case 'InventorySetQuantities':
        return { inventorySetQuantities: { userErrors: [] } };
      case 'InventorySettingsUpdate':
        return { inventorySettingsUpdate: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe('Stock', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists what runs low, the fewest first, and takes away what came damaged, no more than on hand', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const low = await screen.findByRole('region', { name: 'Running low' });
    expect(within(low).getByText('Low means 5 or fewer for sale.')).toBeTruthy();
    expect(within(low).getByText(/^Out of stock/)).toBeTruthy();
    expect(within(low).getByText('2 for sale')).toBeTruthy();
    expect(within(low).getByRole('link', { name: 'Lawn suit · M' }).getAttribute('href')).toBe(
      '/shop_1/products/prod_1',
    );

    fireEvent.click(within(low).getByRole('button', { name: 'Show the stock of Lawn suit · M' }));
    expect(await within(low).findByText('Main warehouse')).toBeTruthy();
    expect(within(low).getByText('On hand').nextSibling?.textContent).toBe('4');
    expect(within(low).getByText('For orders').nextSibling?.textContent).toBe('2');
    expect(within(low).getByText(/received/)).toBeTruthy();
    expect(within(low).getByText(/an order/)).toBeTruthy();

    fireEvent.click(within(low).getByRole('button', { name: 'Add or take away' }));
    fireEvent.click(within(low).getByLabelText('Take away'));
    type('How many', '5');
    expect(within(low).getByText('There are only 4 on hand.')).toBeTruthy();
    type('How many', '1');
    expect((within(low).getByLabelText('Why') as HTMLSelectElement).value).toBe('damaged');
    fireEvent.click(within(low).getByRole('button', { name: 'Take away 1' }));
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryAdjust')).toEqual({
        input: {
          name: 'available',
          reason: 'damaged',
          changes: [{ inventoryItemId: 'inv_1', locationId: 'loc_1', delta: -1 }],
        },
      }),
    );
  });

  it('moves stock to another location, no more than is available, or says to add one', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const low = await screen.findByRole('region', { name: 'Running low' });
    fireEvent.click(within(low).getByRole('button', { name: 'Show the stock of Lawn suit · M' }));
    fireEvent.click(await within(low).findByRole('button', { name: 'Move' }));
    // Only other locations are offered; 2 of the 4 on hand are owed to orders.
    const to = (await within(low).findByLabelText('To')) as HTMLSelectElement;
    expect([...to.options].map((option) => option.text)).toEqual(['Gulberg shop']);
    type('How many', '3');
    expect(within(low).getByText('Only 2 are available here.')).toBeTruthy();
    type('How many', '2');
    fireEvent.click(within(low).getByRole('button', { name: 'Move 2 to Gulberg shop' }));
    await waitFor(() =>
      expect(sentOf(fake, 'InventoryMove')).toEqual({
        input: {
          reason: 'movement_created',
          changes: [
            {
              inventoryItemId: 'inv_1',
              quantity: 2,
              from: { locationId: 'loc_1', name: 'available' },
              to: { locationId: 'loc_2', name: 'available' },
            },
          ],
        },
      }),
    );
    cleanup();

    vi.stubGlobal('fetch', core('owner', [MAIN]).fetcher);
    renderAdmin('/shop_1/stock');
    const again = await screen.findByRole('region', { name: 'Running low' });
    fireEvent.click(within(again).getByRole('button', { name: 'Show the stock of Dupatta' }));
    fireEvent.click(await within(again).findByRole('button', { name: 'Move' }));
    expect(
      await within(again).findByText('The shop has no other location to move stock to.'),
    ).toBeTruthy();
    expect(within(again).getByRole('link', { name: 'Add a location' }).getAttribute('href')).toBe(
      '/shop_1/settings/locations',
    );
  });

  it('counts a shelf against what was on hand when read, and changes what the shop calls low', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const low = await screen.findByRole('region', { name: 'Running low' });
    fireEvent.click(within(low).getByRole('button', { name: 'Show the stock of Dupatta' }));
    fireEvent.click(await within(low).findByRole('button', { name: 'Count' }));
    const counted = within(low).getByLabelText('Counted on the shelf') as HTMLInputElement;
    expect(counted.value).toBe('4');
    fireEvent.change(counted, { target: { value: '6' } });
    fireEvent.click(within(low).getByRole('button', { name: 'Save the count' }));
    await waitFor(() =>
      expect(sentOf(fake, 'InventorySetQuantities')).toEqual({
        input: {
          name: 'on_hand',
          reason: 'cycle_count_available',
          quantities: [
            { inventoryItemId: 'inv_2', locationId: 'loc_1', quantity: 6, compareQuantity: 4 },
          ],
        },
      }),
    );

    fireEvent.click(within(low).getByRole('button', { name: 'Change' }));
    type('Low at this many or fewer', '3');
    fireEvent.click(within(low).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'InventorySettingsUpdate')).toEqual({ input: { lowStockThreshold: 3 } }),
    );
  });

  it('finds a product whose stock is not counted, and starts counting it at the primary location', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const find = await screen.findByRole('region', { name: 'Find a product' });
    fireEvent.change(within(find).getByLabelText('Find products by name or SKU'), {
      target: { value: 'khussa' },
    });
    fireEvent.click(within(find).getByRole('button', { name: 'Find' }));
    expect(await within(find).findByText('Stock not counted')).toBeTruthy();
    fireEvent.click(within(find).getByRole('button', { name: 'Show the stock of Khussa' }));
    expect(await within(find).findByText(/not counted yet/)).toBeTruthy();
    fireEvent.click(within(find).getByRole('button', { name: 'Count it at Main warehouse' }));
    type('Counted on the shelf', '12');
    fireEvent.click(within(find).getByRole('button', { name: 'Save the count' }));
    await waitFor(() =>
      expect(sentOf(fake, 'InventorySetQuantities')).toEqual({
        input: {
          name: 'on_hand',
          reason: 'cycle_count_available',
          quantities: [{ inventoryItemId: 'inv_3', locationId: 'loc_1', quantity: 12 }],
        },
      }),
    );
  });

  it('shows stock to a packer without changing it, and running low on Home', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/stock');

    const low = await screen.findByRole('region', { name: 'Running low' });
    fireEvent.click(within(low).getByRole('button', { name: 'Show the stock of Dupatta' }));
    await within(low).findByText('Main warehouse');
    expect(within(low).queryByRole('button', { name: 'Add or take away' })).toBeNull();
    expect(within(low).queryByRole('button', { name: 'Count' })).toBeNull();
    expect(within(low).queryByRole('button', { name: 'Move' })).toBeNull();
    expect(within(low).queryByRole('button', { name: 'Change' })).toBeNull();
    cleanup();

    const tally = (count: number) => ({ count, total: rupees('0') });
    vi.stubGlobal(
      'fetch',
      fakeCore('owner', (operation) => {
        switch (operation) {
          case 'SetupChecklist':
            return { setupChecklist: { done: 8, total: 8, steps: [] } };
          case 'HomeStock':
            return { home: { lowStock: { low: 2, out: 1, threshold: 5 } } };
          case 'Home':
            return {
              shop: { timezone: 'Asia/Karachi' },
              home: {
                toConfirm: tally(0),
                toReview: tally(0),
                awaitingPayment: tally(0),
                transfersToCheck: tally(0),
                toPack: tally(0),
                toBook: tally(0),
                returning: tally(0),
                returnsToReceive: tally(0),
                cashToCollect: tally(0),
                lostToClaim: tally(0),
                claimsOpen: tally(0),
                today: {
                  since: LATER,
                  sales: tally(0),
                  salesYesterday: tally(0),
                  delivered: tally(0),
                  returnedToOrigin: tally(0),
                },
              },
            };
          default:
            throw new Error(`unexpected ${operation}`);
        }
      }).fetcher,
    );
    renderAdmin('/shop_1');
    const stock = await screen.findByRole('link', { name: /Stock running low/ });
    expect(stock.textContent).toContain('2 running low · 1 out of stock');
    expect(stock.getAttribute('href')).toBe('/shop_1/stock');
  });
});

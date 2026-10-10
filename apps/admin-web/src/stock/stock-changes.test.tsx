import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';

const MAIN = { id: 'loc_1', name: 'Main warehouse' };
const SHOP = { id: 'loc_2', name: 'Liberty shop' };

const level = (id: string, location: typeof MAIN, onHand: number) => ({
  id,
  available: onHand,
  onHand,
  committed: 0,
  reserved: 0,
  safetyStock: 0,
  location,
});

function change(delta: number, reason: string, after: number, location = MAIN, order?: string) {
  return {
    createdAt: LATER,
    delta,
    name: reason === 'committed' ? 'committed' : 'available',
    reason,
    quantityAfterChange: after,
    referenceDocumentUri: order ? `hatti://orders/${order}` : null,
    location,
  };
}

const LATEST = [change(1, 'committed', 1, MAIN, 'ord_01abc'), change(-2, 'damaged', 2, SHOP)];

/** A fake core with a lawn suit stocked at two places, its history longer than one page. */
function historyCore() {
  return fakeCore('manager', (operation, variables) => {
    switch (operation) {
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
                sku: null,
                available: 3,
                inventoryItem: { id: 'inv_1' },
              },
            ],
          },
        };
      case 'InventoryItem':
        return {
          location: MAIN,
          inventoryItem: {
            id: 'inv_1',
            tracked: true,
            inventoryLevels: [level('lvl_1', MAIN, 2), level('lvl_2', SHOP, 1)],
            changes: {
              nodes: LATEST,
              pageInfo: { hasNextPage: true, endCursor: 'c2' },
            },
          },
        };
      case 'InventoryChanges': {
        const at = variables.locationId as string | null;
        const nodes =
          at === 'loc_2'
            ? [change(-2, 'damaged', 2, SHOP), change(4, 'received', 4, SHOP)]
            : variables.after === 'c2'
              ? [change(10, 'received', 10)]
              : LATEST;
        return {
          inventoryItem: {
            id: 'inv_1',
            changes: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A variant's stock history (INV-03)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows each change with what was left and its order, older ones as asked, and those at one place', async () => {
    const fake = historyCore();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const low = await screen.findByRole('region', { name: 'Running low' });
    fireEvent.click(within(low).getByRole('button', { name: 'Show the stock of Lawn suit · M' }));
    const history = (await within(low).findByText('Latest changes')).parentElement!;
    const rows = () =>
      within(history)
        .getAllByRole('listitem')
        .map((row) => row.textContent);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatch(/^\+1 .* · 1 after · Main warehouse · Its order/);
    expect(within(history).getByRole('link', { name: 'Its order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_01abc',
    );
    expect(rows()[1]).toMatch(/^-2 .* · 2 after · Liberty shop/);

    await press('Older changes');
    await within(history).findByText(/^\+10/);
    expect(rows()).toHaveLength(3);
    expect(
      fake.sent.filter((each) => each.operation === 'InventoryChanges').at(-1)?.variables,
    ).toEqual({
      id: 'inv_1',
      after: 'c2',
      locationId: null,
    });
    expect(screen.queryByRole('button', { name: 'Older changes' })).toBeNull();

    fireEvent.change(within(history).getByLabelText('Where'), { target: { value: 'loc_2' } });
    await within(history).findByText(/^\+4/);
    expect(rows()).toHaveLength(2);
    // At one place, its name goes without saying.
    expect(rows().some((row) => row?.includes('Liberty shop'))).toBe(false);
    expect(
      fake.sent.filter((each) => each.operation === 'InventoryChanges').at(-1)?.variables,
    ).toEqual({
      id: 'inv_1',
      after: null,
      locationId: 'loc_2',
    });
  });
});

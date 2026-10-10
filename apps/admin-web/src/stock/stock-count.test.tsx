import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const MAIN = { id: 'loc_1', name: 'Main warehouse', isPrimary: true };
const SHOP = { id: 'loc_2', name: 'Gulberg shop', isPrimary: false };

const variant = (
  id: string,
  title: string,
  sku: string,
  barcode: string | null,
  onHand: number | null,
) => ({
  id: `var_${id}`,
  title,
  sku,
  barcode,
  inventoryItem: {
    id: `inv_${id}`,
    inventoryLevel: onHand === null ? null : { onHand },
  },
});

/**
 * A lawn suit whose medium has a barcode and 4 on hand at the main warehouse, and whose large has
 * a SKU and was never stocked there; the medium's on hand moves to 6 once a count is first saved,
 * as an order took some back, so that save is refused as stale.
 */
function countCore(role: StaffRole) {
  let saves = 0;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'LowStock':
        return { inventorySettings: { lowStockThreshold: 5 }, inventoryLowStock: { nodes: [] } };
      case 'Locations':
        return { locations: { nodes: [MAIN, SHOP] } };
      case 'StockCountFind': {
        const query = String(variables.query);
        const products =
          query === 'barcode:"8964000000017"'
            ? [variant('1', 'M', 'LS-M', '8964000000017', saves > 0 ? 6 : 4)]
            : query === 'sku:"LS-L"'
              ? [variant('9', 'L', 'LS-L', null, null)]
              : [];
        return {
          products: {
            nodes: products.length
              ? [{ id: 'prod_1', title: 'Lawn suit', variants: products }]
              : [],
          },
        };
      }
      case 'InventorySetQuantities':
        saves += 1;
        return {
          inventorySetQuantities: {
            userErrors:
              saves === 1
                ? [
                    {
                      field: ['input', 'quantities', '1', 'compareQuantity'],
                      code: 'STALE',
                      message: 'The quantity is 6 now, not 4; read it again',
                    },
                  ]
                : [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof countCore>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('A stock count by scanning (INV-07)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds what is scanned or typed, one more of each again, and saves every count together, reading again what moved', async () => {
    const fake = countCore('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/stock');

    const count = await screen.findByRole('region', { name: 'Count by scanning' });
    fireEvent.click(within(count).getByRole('button', { name: 'Start a count' }));
    const where = (await within(count).findByLabelText('Location counted')) as HTMLSelectElement;
    expect(where.value).toBe('loc_1');

    const add = async (code: string) => {
      type('Barcode or SKU', code);
      await press('Add');
    };
    await add('8964000000017');
    expect(await within(count).findByText('Lawn suit · M')).toBeTruthy();
    expect(within(count).getByText('4 on hand when scanned')).toBeTruthy();
    const medium = within(count).getByLabelText('Counted of Lawn suit · M') as HTMLInputElement;
    expect(medium.value).toBe('1');
    // Scanned again: one more, without asking the core.
    await add('8964000000017');
    expect(medium.value).toBe('2');
    // A SKU, after no barcode was found; never stocked here, so none were on hand.
    await add('LS-L');
    expect(await within(count).findByText('Lawn suit · L')).toBeTruthy();
    expect(within(count).getByText('0 on hand when scanned')).toBeTruthy();
    expect(sentOf(fake, 'StockCountFind')).toEqual([
      { query: 'barcode:"8964000000017"', locationId: 'loc_1' },
      { query: 'barcode:"LS-L"', locationId: 'loc_1' },
      { query: 'sku:"LS-L"', locationId: 'loc_1' },
    ]);
    await add('NOPE');
    expect(await within(count).findByText('Nothing has the barcode or SKU NOPE.')).toBeTruthy();
    // The location stays as counted once anything is.
    expect(within(count).queryByLabelText('Location counted')).toBeNull();
    expect(within(count).getByText('Counting at Main warehouse')).toBeTruthy();

    type('Counted of Lawn suit · L', '5');
    await press('Save 2 counts');
    expect(
      await within(count).findByText(
        '1 item changed since it was scanned, so nothing was saved. Check it and save again.',
      ),
    ).toBeTruthy();
    expect(
      await within(count).findByText('Changed since: 6 on hand now. Check the count.'),
    ).toBeTruthy();
    await press('Save 2 counts');
    expect(await within(count).findByText('2 counts saved at Main warehouse.')).toBeTruthy();
    expect(within(count).queryByText('Lawn suit · M')).toBeNull();
    const quantities = (compareMedium: number) => ({
      input: {
        name: 'on_hand',
        reason: 'cycle_count_available',
        quantities: [
          { inventoryItemId: 'inv_9', locationId: 'loc_1', quantity: 5, compareQuantity: 0 },
          {
            inventoryItemId: 'inv_1',
            locationId: 'loc_1',
            quantity: 2,
            compareQuantity: compareMedium,
          },
        ],
      },
    });
    expect(sentOf(fake, 'InventorySetQuantities')).toEqual([quantities(4), quantities(6)]);
  });

  it('counts at the location chosen, removes a line, and reads one code after another through the camera', async () => {
    const fake = countCore('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect() {
          return Promise.resolve([{ rawValue: '8964000000017' }]);
        }
      },
    );
    const stopped = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: () =>
          Promise.resolve(
            Object.assign(new MediaStream(), { getTracks: () => [{ stop: stopped }] }),
          ),
      },
      configurable: true,
    });
    try {
      renderAdmin('/shop_1/stock');
      const count = await screen.findByRole('region', { name: 'Count by scanning' });
      fireEvent.click(within(count).getByRole('button', { name: 'Start a count' }));
      fireEvent.change(await within(count).findByLabelText('Location counted'), {
        target: { value: 'loc_2' },
      });
      fireEvent.click(within(count).getByRole('button', { name: 'Scan a barcode' }));
      const medium = (await within(count).findByLabelText(
        'Counted of Lawn suit · M',
      )) as HTMLInputElement;
      expect(medium.value).toBe('1');
      // The camera stays open: the same box held up again after the pause is one more.
      await waitFor(() => expect(medium.value).toBe('2'), { timeout: 4000 });
      expect(stopped).not.toHaveBeenCalled();
      fireEvent.click(within(count).getByRole('button', { name: 'Stop scanning' }));
      expect(stopped).toHaveBeenCalled();
      expect(sentOf(fake, 'StockCountFind')[0]).toEqual({
        query: 'barcode:"8964000000017"',
        locationId: 'loc_2',
      });
      fireEvent.click(
        within(count).getByRole('button', { name: 'Remove Lawn suit · M from the count' }),
      );
      expect(within(count).queryByText('Lawn suit · M')).toBeNull();
      expect(within(count).getByLabelText('Location counted')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('is for those who change stock', async () => {
    vi.stubGlobal('fetch', countCore('packer').fetcher);
    renderAdmin('/shop_1/stock');
    await screen.findByRole('region', { name: 'Running low' });
    expect(screen.queryByRole('region', { name: 'Count by scanning' })).toBeNull();
  });
});

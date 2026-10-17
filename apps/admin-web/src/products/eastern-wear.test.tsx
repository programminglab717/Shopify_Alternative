import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(easternWear: unknown) {
  return {
    id: 'prod_1',
    title: 'Eid lawn',
    description: '',
    handle: 'eid-lawn',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard: false,
    easternWear,
    preorder: null,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '5000.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: false,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

function core(easternWear: unknown) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(easternWear) };
      case 'ProductUpdate':
        return { productUpdate: { product: { id: 'prod_1' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'ProductUpdate').map((each) => each.variables);

describe("A product's eastern-wear attributes, on its page (CAT-08, ADR-477)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says it is unstitched, 3-piece, of lawn and chiffon, for summer, at most three fabrics', async () => {
    const fake = core(null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const save = await screen.findByRole('button', { name: 'Save eastern wear' });
    fireEvent.change(screen.getByLabelText('Stitching'), { target: { value: 'UNSTITCHED' } });
    fireEvent.change(screen.getByLabelText('Pieces'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: 'SUMMER' } });
    fireEvent.click(screen.getByLabelText('Lawn'));
    fireEvent.click(screen.getByLabelText('Chiffon'));
    fireEvent.click(screen.getByLabelText('Silk'));
    // A fourth can't be ticked until one is taken off.
    expect((screen.getByLabelText('Net') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Silk'));
    expect((screen.getByLabelText('Net') as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([
        {
          input: {
            id: 'prod_1',
            easternWear: {
              stitching: 'UNSTITCHED',
              pieces: 3,
              fabrics: ['LAWN', 'CHIFFON'],
              season: 'SUMMER',
            },
          },
        },
      ]),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('clears them all, as none said', async () => {
    const fake = core({ stitching: 'STITCHED', pieces: null, fabrics: ['KHADDAR'], season: null });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    expect(((await screen.findByLabelText('Khaddar')) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Stitching'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Khaddar'));
    fireEvent.click(screen.getByRole('button', { name: 'Save eastern wear' }));
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([{ input: { id: 'prod_1', easternWear: null } }]),
    );
  });
});

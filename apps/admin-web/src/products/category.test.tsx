import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(category: string | null, condition: string) {
  return {
    id: 'prod_1',
    title: 'Khussa',
    description: '',
    handle: 'khussa',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard: false,
    category,
    condition,
    easternWear: null,
    preorder: null,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '2500.00', currencyCode: 'PKR' },
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

function core(category: string | null, condition: string) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          product: product(category, condition),
        };
      case 'ProductUpdate':
        return { productUpdate: { product: { id: 'prod_1' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'ProductUpdate').map((each) => each.variables);

describe("A product's category and condition, on its page (CAT-18, ADR-483)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is given one of Google's categories and said to be used, then has the category cleared", async () => {
    const fake = core(null, 'NEW');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const save = await screen.findByRole('button', { name: 'Save category' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole('option', { name: 'Apparel & Accessories > Shoes' });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Apparel & Accessories > Shoes' },
    });
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'USED' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([
        {
          input: { id: 'prod_1', category: 'Apparel & Accessories > Shoes', condition: 'USED' },
        },
      ]),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake)[1]).toEqual({
        input: { id: 'prod_1', category: null, condition: 'USED' },
      }),
    );
  });

  it('keeps a category of its own that the list no longer offers', async () => {
    const fake = core('Arts & Entertainment', 'REFURBISHED');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const category = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    expect(category.value).toBe('Arts & Entertainment');
    expect((screen.getByLabelText('Condition') as HTMLSelectElement).value).toBe('REFURBISHED');
  });
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const LOCATION = { id: 'loc_1', name: 'Lahore warehouse' };
const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

function variant(id: string, size: string, price: string, available: number | null) {
  return {
    id,
    title: size,
    price: pkr(price),
    compareAtPrice: null,
    sku: null,
    selectedOptions: [{ name: 'Size', value: size }],
    inventoryQuantity: available ?? 0,
    inventoryItem: {
      id: `item_${size}`,
      tracked: available !== null,
      inventoryLevels: available === null ? [] : [{ available, location: { id: LOCATION.id } }],
    },
  };
}

const KURTA = {
  id: 'prod_1',
  title: 'Khaddar Kurta',
  description: 'Warm khaddar.',
  handle: 'khaddar-kurta',
  status: 'ACTIVE',
  productType: 'Kurta',
  vendor: null,
  tags: ['winter'],
  totalInventory: 13,
  tracksInventory: true,
  options: [
    {
      id: 'opt_1',
      name: 'Size',
      optionValues: [
        { id: 'v1', name: 'S' },
        { id: 'v2', name: 'M' },
      ],
    },
  ],
  media: [],
  variants: [variant('var_s', 'S', '3200.00', 5), variant('var_m', 'M', '3200.00', 8)],
};

/** A fake core with the kurta in its catalog, which answers what each products screen asks. */
function catalogCore(role: StaffRole) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Products':
        return {
          products: {
            nodes: [
              {
                ...KURTA,
                priceRange: { minVariantPrice: pkr('3200.00'), maxVariantPrice: pkr('3200.00') },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'PrimaryLocation':
        return { location: LOCATION };
      case 'ProductSuggestions':
        return { productTypes: ['Kurtas', 'Shawls'], productVendors: ['Zari Studio'] };
      case 'Product':
        return { location: LOCATION, product: KURTA };
      case 'ProductCreate':
        return {
          productCreate: {
            product: {
              id: 'prod_1',
              variants: KURTA.variants.map(({ id, inventoryItem, selectedOptions }) => ({
                id,
                inventoryItem: { id: inventoryItem.id },
                selectedOptions,
              })),
            },
            userErrors: [],
          },
        };
      case 'ProductVariantsBulkUpdate':
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
      case 'InventorySetQuantities':
        return { inventorySetQuantities: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Products in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a product in sizes, each with its price and stock', async () => {
    const core = catalogCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/products/new');

    await screen.findByRole('heading', { name: 'Add product' });
    type('Title', 'Khaddar Kurta');
    fireEvent.click(screen.getByLabelText('It comes in sizes, colours or other options'));
    type('Option', 'Size');
    type('Values', 'S, M, S');
    type('Price of each', '3,200');
    type('Price of M', '3500');
    type('In stock of S', '5');
    await press('Save product');

    await screen.findByText('Product added. Add photos and share it.');
    expect(router.state.location.pathname).toBe('/shop_1/products/prod_1');
    expect(core.sent.find((each) => each.operation === 'ProductCreate')?.variables).toEqual({
      input: {
        title: 'Khaddar Kurta',
        description: '',
        status: 'ACTIVE',
        productType: null,
        vendor: null,
        tags: [],
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [
          { optionValues: ['S'], price: '3200', sku: null },
          { optionValues: ['M'], price: '3500', sku: null },
        ],
      },
    });
    // Stock where it was counted alone, at the primary location.
    expect(
      core.sent.find((each) => each.operation === 'InventorySetQuantities')?.variables,
    ).toEqual({
      input: {
        name: 'available',
        reason: 'received',
        quantities: [{ inventoryItemId: 'item_S', quantity: 5, locationId: 'loc_1' }],
      },
    });
  });

  it("offers the shop's own product types and vendors as they are typed", async () => {
    vi.stubGlobal('fetch', catalogCore('owner').fetcher);
    renderAdmin('/shop_1/products/new');

    await screen.findByRole('heading', { name: 'Add product' });
    const offered = async (label: string) => {
      const input = screen.getByLabelText(label);
      const list = document.getElementById(input.getAttribute('list')!)!;
      await waitFor(() => expect(list.querySelectorAll('option').length).toBeGreaterThan(0));
      return [...list.querySelectorAll('option')].map((option) => option.value);
    };
    expect(await offered('Type')).toEqual(['Kurtas', 'Shawls']);
    expect(await offered('Brand')).toEqual(['Zari Studio']);
  });

  it('catches a price that is not one before sending anything', async () => {
    const core = catalogCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/new');

    await screen.findByRole('heading', { name: 'Add product' });
    type('Title', 'Ajrak');
    type('Price', 'Rs 1800');
    await press('Save product');
    expect(screen.getByText('Enter a price, such as 2500.')).toBeTruthy();
    expect(core.sent.map((each) => each.operation)).not.toContain('ProductCreate');
  });

  it('saves only what changed on a product, its stock as it was read', async () => {
    const core = catalogCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    await screen.findByDisplayValue('Khaddar Kurta');
    expect(screen.getByText('Stock counted at Lahore warehouse.')).toBeTruthy();
    type('Price of M', '3300');
    type('In stock of S', '4');
    await press('Save');

    await screen.findByText('Saved.');
    const operations = core.sent.map((each) => each.operation);
    expect(operations).not.toContain('ProductUpdate');
    expect(
      core.sent.find((each) => each.operation === 'ProductVariantsBulkUpdate')?.variables,
    ).toEqual({
      productId: 'prod_1',
      variants: [{ id: 'var_m', price: '3300', compareAtPrice: null, sku: null }],
    });
    expect(
      core.sent.find((each) => each.operation === 'InventorySetQuantities')?.variables,
    ).toEqual({
      input: {
        name: 'available',
        reason: 'correction',
        quantities: [
          { inventoryItemId: 'item_S', locationId: 'loc_1', quantity: 4, compareQuantity: 5 },
        ],
      },
    });
  });

  it('shows a packer the products, but nothing to change them with', async () => {
    const core = catalogCore('packer');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products');

    await screen.findByText('13 in stock');
    expect(screen.getByText('across 2 variants')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add product' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: /Khaddar Kurta/ }));
    const title = await screen.findByDisplayValue('Khaddar Kurta');
    expect(title.closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

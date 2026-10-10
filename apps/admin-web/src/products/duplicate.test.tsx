import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const photo = (id: string, position: number) => ({
  id,
  status: 'READY',
  alt: 'Ajrak',
  position,
  mediaContentType: 'IMAGE',
  previewImage: { url: `http://localhost:4000/images/${id}` },
  mediaErrors: [],
});

function product(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    description: '',
    handle: 'sindhi-ajrak',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    options: [{ id: 'opt_1', name: 'Title', optionValues: [{ id: 'v1', name: 'Default Title' }] }],
    media: [photo('media_1', 1), photo('media_2', 2)],
    variants: [
      {
        id: `${id}_var`,
        title: 'Default Title',
        price: { amount: '1800.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        selectedOptions: [{ name: 'Title', value: 'Default Title' }],
        inventoryQuantity: 0,
        inventoryItem: { id: `${id}_item`, tracked: false, inventoryLevels: [] },
      },
    ],
    ...extra,
  };
}

/** A fake core with an ajrak to duplicate, which refuses a copy titled "Refused". */
function duplicateCore(role: StaffRole, photos = true) {
  const products = new Map([
    ['prod_1', product('prod_1', 'Sindhi Ajrak', photos ? {} : { media: [] })],
  ]);
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Shop' },
          product: products.get(variables.id as string) ?? null,
        };
      case 'ProductDuplicate': {
        if (variables.newTitle === 'Refused') {
          return {
            productDuplicate: {
              newProduct: null,
              userErrors: [
                { field: ['productId'], code: 'NOT_FOUND', message: 'Product not found' },
              ],
            },
          };
        }
        const copy = product('prod_2', variables.newTitle as string, {
          status: 'DRAFT',
          media: variables.includeImages ? [photo('media_3', 1), photo('media_4', 2)] : [],
        });
        products.set(copy.id, copy);
        return { productDuplicate: { newProduct: { id: copy.id }, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof duplicateCore>) =>
  core.sent.filter((each) => each.operation === 'ProductDuplicate').map((each) => each.variables);

describe('A product duplicated, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('copies a product as a draft, its photos if asked, and opens the copy', async () => {
    const core = duplicateCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    await screen.findByRole('heading', { name: 'Sindhi Ajrak' });
    await press('Duplicate');
    expect(screen.getByRole('heading', { name: 'Duplicate Sindhi Ajrak' })).toBeTruthy();
    expect((screen.getByLabelText('Title of the copy') as HTMLInputElement).value).toBe(
      'Copy of Sindhi Ajrak',
    );
    expect(
      screen.getByText(
        'The copy has its words, options, variants and prices. It starts as a draft, hidden from your store, with no stock, and its SKUs and barcodes are left for you to give.',
      ),
    ).toBeTruthy();
    const photos = screen.getByRole('checkbox', { name: 'Copy its photos and videos too' });
    expect((photos as HTMLInputElement).checked).toBe(false);

    type('Title of the copy', '  Sindhi Ajrak - Maroon ');
    fireEvent.click(photos);
    await press('Duplicate');

    await screen.findByRole('heading', { name: 'Sindhi Ajrak - Maroon' });
    expect(
      screen.getByText(
        'Copied as a draft. Change what differs, enter its stock, and show it when it is ready.',
      ),
    ).toBeTruthy();
    expect(sentOf(core)).toEqual([
      {
        productId: 'prod_1',
        newTitle: 'Sindhi Ajrak - Maroon',
        newStatus: 'DRAFT',
        includeImages: true,
      },
    ]);
  });

  it('says what the core refuses, asks of photos only where there are some, and is for those who change products', async () => {
    const core = duplicateCore('owner', false);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    await screen.findByRole('heading', { name: 'Sindhi Ajrak' });
    await press('Duplicate');
    expect(screen.queryByRole('checkbox', { name: 'Copy its photos and videos too' })).toBeNull();
    type('Title of the copy', ' ');
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveProperty('disabled', true);
    type('Title of the copy', 'Refused');
    await press('Duplicate');
    await screen.findByText('Product not found');
    expect(sentOf(core)).toEqual([
      { productId: 'prod_1', newTitle: 'Refused', newStatus: 'DRAFT', includeImages: false },
    ]);
    await press('Cancel');
    expect(screen.queryByLabelText('Title of the copy')).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', duplicateCore('packer').fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Sindhi Ajrak' });
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
  });
});

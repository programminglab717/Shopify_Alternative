import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';
import { preparePhoto } from './photos';

const photo = (id: string, position: number) => ({
  id,
  status: 'READY',
  alt: 'Ajrak',
  position,
  mediaContentType: 'IMAGE',
  previewImage: { url: `http://localhost:4000/images/${id}` },
  mediaErrors: [],
});

const AJRAK = {
  id: 'prod_1',
  title: 'Sindhi Ajrak',
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
      id: 'var_1',
      title: 'Default Title',
      price: { amount: '1800.00', currencyCode: 'PKR' },
      compareAtPrice: null,
      sku: null,
      selectedOptions: [{ name: 'Title', value: 'Default Title' }],
      inventoryQuantity: 0,
      inventoryItem: { id: 'item_1', tracked: false, inventoryLevels: [] },
    },
  ],
};

const STORAGE = 'http://localhost:4000/storage/shops/shop_1/files/f1/ajrak.jpg';

function photosCore() {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Shop' }, product: AJRAK };
      case 'StagedUploadsCreate':
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: `${STORAGE}?expires=1&signature=s`,
                httpMethod: 'PUT',
                resourceUrl: STORAGE,
                parameters: [{ name: 'content-type', value: 'image/jpeg' }],
              },
            ],
            userErrors: [],
          },
        };
      case 'ProductCreateMedia':
        return {
          productCreateMedia: { media: [{ id: 'media_3', status: 'UPLOADED' }], userErrors: [] },
        };
      case 'ProductReorderMedia':
        return { productReorderMedia: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A product's photos", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a small photo as it is, and nothing it cannot read', async () => {
    const small = new File([new Uint8Array(1000)], 'ajrak.jpg', { type: 'image/jpeg' });
    expect(await preparePhoto(small)).toBe(small);
    const heic = new File([new Uint8Array(10)], 'IMG_0001.heic', { type: 'image/heic' });
    expect(await preparePhoto(heic)).toBeNull();
  });

  it('uploads the photos chosen straight to storage, and adds them to the product', async () => {
    const core = photosCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    await screen.findByText('Main');
    const input = screen.getByLabelText('Add photos', { selector: 'input' });
    await act(async () =>
      fireEvent.change(input, {
        target: {
          files: [
            new File([new Uint8Array(4)], 'ajrak.jpg', { type: 'image/jpeg' }),
            new File([new Uint8Array(4)], 'IMG_0001.heic', { type: 'image/heic' }),
          ],
        },
      }),
    );

    await screen.findByText(
      'IMG_0001.heic is not a photo we can use: choose a JPEG, PNG, WebP or GIF.',
    );
    expect(core.sent.find((each) => each.operation === 'StagedUploadsCreate')?.variables).toEqual({
      input: [{ filename: 'ajrak.jpg', mimeType: 'image/jpeg', fileSize: '4' }],
    });
    expect(core.uploads).toEqual([
      { url: `${STORAGE}?expires=1&signature=s`, type: 'image/jpeg', size: 4 },
    ]);
    expect(core.sent.find((each) => each.operation === 'ProductCreateMedia')?.variables).toEqual({
      productId: 'prod_1',
      media: [{ originalSource: STORAGE, alt: 'Sindhi Ajrak', mediaContentType: 'IMAGE' }],
    });
  });

  it('makes another photo the main one', async () => {
    const core = photosCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    await screen.findByText('Main');
    await press('Make it the main photo');
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'ProductReorderMedia')?.variables).toEqual(
        { productId: 'prod_1', moves: [{ id: 'media_2', newPosition: 1 }] },
      ),
    );
  });
});

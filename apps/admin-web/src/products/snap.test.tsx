import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const STORAGE = 'http://localhost:4000/storage/shops/shop_1/files/f1/kurta.jpg';

const product = (status: string, title = 'New product from a photo') => ({
  id: 'prod_9',
  title,
  description: '',
  handle: 'new-product-from-a-photo',
  status: 'DRAFT',
  productType: null,
  vendor: null,
  tags: [],
  totalInventory: 0,
  tracksInventory: false,
  options: [{ id: 'opt_1', name: 'Title', optionValues: [{ id: 'v1', name: 'Default Title' }] }],
  media: [
    {
      id: 'media_9',
      status,
      alt: '',
      position: 1,
      mediaContentType: 'IMAGE',
      previewImage: status === 'READY' ? { url: 'http://localhost:4000/images/media_9' } : null,
      mediaErrors: [],
    },
  ],
  variants: [
    {
      id: 'var_9',
      title: 'Default Title',
      price: { amount: '3500.00', currencyCode: 'PKR' },
      compareAtPrice: null,
      sku: null,
      selectedOptions: [{ name: 'Title', value: 'Default Title' }],
      inventoryQuantity: 0,
      inventoryItem: { id: 'item_9', tracked: false, inventoryLevels: [] },
    },
  ],
});

/** The core, the photo ready once asked after `readyAfter` times; drafts where `ai` says. */
function snapCore({ ai = true, readyAfter = 1 } = {}) {
  let asked = 0;
  let title = 'New product from a photo';
  return fakeCore('owner', (operation, variables) => {
    switch (operation) {
      case 'ProductCopyDrafting':
        return { productCopyDrafting: { available: ai, usedToday: 0, limitPerDay: 100 } };
      case 'ProductCreate':
        return {
          productCreate: {
            product: { id: 'prod_9', variants: [{ id: 'var_9', inventoryItem: { id: 'item_9' } }] },
            userErrors: [],
          },
        };
      case 'StagedUploadsCreate':
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              { url: `${STORAGE}?s=1`, httpMethod: 'PUT', resourceUrl: STORAGE, parameters: [] },
            ],
            userErrors: [],
          },
        };
      case 'ProductCreateMedia':
        return {
          productCreateMedia: { media: [{ id: 'media_9', status: 'UPLOADED' }], userErrors: [] },
        };
      case 'Product':
        asked += 1;
        return {
          location: { id: 'loc_1', name: 'Shop' },
          product: product(asked > readyAfter ? 'READY' : 'PROCESSING', title),
        };
      case 'ProductAutoCropMedia':
        return {
          productAutoCropMedia: { croppedMediaIds: ['media_9'], skipped: [], userErrors: [] },
        };
      case 'ProductCopyDraft':
        return {
          productCopyDraft: {
            draft: {
              title: 'Plum embroidered kurta',
              descriptionHtml: '<p>A plum kurta.</p><ul><li>Embroidered neckline</li></ul>',
              seoTitle: 'Plum embroidered kurta',
              seoDescription: 'A plum kurta with an embroidered neckline.',
            },
            userErrors: [],
          },
        };
      case 'ProductUpdate':
        title = (variables.input as { title: string }).title;
        return { productUpdate: { product: { id: 'prod_9' }, userErrors: [] } };
      default:
        return {};
    }
  });
}

const sentOf = (fake: ReturnType<typeof snapCore>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const choose = async () => {
  const camera = await screen.findByLabelText('Take a photo');
  expect(camera.getAttribute('capture')).toBe('environment');
  fireEvent.change(camera, {
    target: { files: [new File([new Uint8Array(1000)], 'kurta.jpg', { type: 'image/jpeg' })] },
  });
};

describe('A product added from a photo (APP-02, ADR-507)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('adds it as a draft with its photo squared, and its words written from the photo', async () => {
    const fake = snapCore();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');
    fireEvent.click(await screen.findByRole('link', { name: 'Add from a photo' }));

    await choose();
    expect(await screen.findByText('kurta.jpg')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Price (optional)'), { target: { value: '3,500' } });
    fireEvent.change(screen.getByLabelText(/What a photo can’t show/), {
      target: { value: 'Cotton, sizes S to L' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add and write it with AI' }));

    expect(
      await screen.findByText(/Added from your photo as a draft/, {}, { timeout: 8000 }),
    ).toBeTruthy();
    expect(sentOf(fake, 'ProductCreate')).toEqual([
      {
        input: {
          title: 'New product from a photo',
          status: 'DRAFT',
          variants: [{ price: '3500' }],
        },
      },
    ]);
    expect(sentOf(fake, 'ProductCreateMedia')[0]).toMatchObject({ productId: 'prod_9' });
    expect(sentOf(fake, 'ProductAutoCropMedia')).toEqual([
      { productId: 'prod_9', aspectRatio: 'SQUARE' },
    ]);
    expect(sentOf(fake, 'ProductCopyDraft')).toEqual([
      {
        input: {
          language: 'ENGLISH',
          productId: 'prod_9',
          usePhotos: true,
          notes: 'Cotton, sizes S to L',
        },
      },
    ]);
    expect(sentOf(fake, 'ProductUpdate')).toEqual([
      {
        input: {
          id: 'prod_9',
          title: 'Plum embroidered kurta',
          description: 'A plum kurta.\n\n• Embroidered neckline',
          seo: {
            title: 'Plum embroidered kurta',
            description: 'A plum kurta with an embroidered neckline.',
          },
        },
      },
    ]);
  }, 15_000);

  it('adds it with its photo alone where Hatti drafts nothing with AI', async () => {
    const fake = snapCore({ ai: false, readyAfter: 0 });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/snap');
    await choose();
    expect(screen.queryByLabelText(/What a photo can’t show/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Add the product' }));
    expect(await screen.findByText(/Added from your photo as a draft/)).toBeTruthy();
    expect(sentOf(fake, 'ProductCreate')[0]).toEqual({
      input: { title: 'New product from a photo', status: 'DRAFT' },
    });
    expect(sentOf(fake, 'ProductAutoCropMedia')).toHaveLength(1);
    expect(sentOf(fake, 'ProductCopyDraft')).toEqual([]);
  });

  it('refuses a price it cannot read, and adds nothing without a photo', async () => {
    const fake = snapCore();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/snap');
    const draft = await screen.findByRole('button', { name: 'Add and write it with AI' });
    expect((draft as HTMLButtonElement).disabled).toBe(true);
    await choose();
    fireEvent.change(screen.getByLabelText('Price (optional)'), { target: { value: 'free' } });
    fireEvent.click(draft);
    await waitFor(() => expect(screen.getByText(/price/i, { selector: 'p' })).toBeTruthy());
    expect(sentOf(fake, 'ProductCreate')).toEqual([]);
  });
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product() {
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
    category: null,
    condition: 'NEW',
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

const CARE = {
  id: 'mfd_1',
  ownerType: 'PRODUCT',
  namespace: 'custom',
  key: 'care',
  type: 'multi_line_text_field',
  name: 'Care instructions',
  description: null,
  metafieldsCount: 1,
};
const LINED = { ...CARE, id: 'mfd_2', key: 'lined', type: 'boolean', name: 'Lined' };
const FABRICS = {
  ...CARE,
  id: 'mfd_3',
  key: 'fabrics',
  type: 'list.single_line_text_field',
  name: 'Fabrics',
};

function core(definitions: unknown[]) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product() };
      case 'ProductMetafields':
        return {
          metafieldDefinitions: definitions,
          product: {
            id: 'prod_1',
            metafields: [
              {
                namespace: 'custom',
                key: 'care',
                type: 'multi_line_text_field',
                value: 'Hand wash',
              },
              {
                namespace: 'custom',
                key: 'fabrics',
                type: 'list.single_line_text_field',
                value: '["Lawn"]',
              },
            ],
          },
        };
      case 'MetafieldsSet':
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      case 'MetafieldsDelete':
        return { metafieldsDelete: { deletedMetafields: [{ key: 'care' }], userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A product's custom fields, on its page (CAT-06, ADR-489)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fills in a field for each definition, by its type, and deletes one emptied', async () => {
    const fake = core([CARE, LINED, FABRICS]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const care = (await screen.findByLabelText('Care instructions')) as HTMLTextAreaElement;
    expect(care.value).toBe('Hand wash');
    expect((screen.getByLabelText('Fabrics') as HTMLTextAreaElement).value).toBe('Lawn');
    const save = screen.getByRole('button', { name: 'Save custom fields' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Lined'), { target: { value: 'true' } });
    fireEvent.change(screen.getByLabelText('Fabrics'), { target: { value: 'Lawn\n Chiffon \n' } });
    fireEvent.change(care, { target: { value: '' } });
    fireEvent.click(save);
    await screen.findByText('Custom fields are saved.');
    const sent = fake.sent.filter((each) => each.operation.startsWith('Metafields'));
    expect(sent.map((each) => [each.operation, each.variables])).toEqual([
      [
        'MetafieldsSet',
        {
          metafields: [
            { ownerId: 'prod_1', namespace: 'custom', key: 'lined', value: 'true' },
            { ownerId: 'prod_1', namespace: 'custom', key: 'fabrics', value: '["Lawn","Chiffon"]' },
          ],
        },
      ],
      [
        'MetafieldsDelete',
        { metafields: [{ ownerId: 'prod_1', namespace: 'custom', key: 'care' }] },
      ],
    ]);
  });

  it('points to Settings where the shop has no fields of its own', async () => {
    const fake = core([]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const link = await screen.findByRole('link', { name: 'Custom data' });
    expect(link.getAttribute('href')).toBe('/shop_1/settings/custom-data');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save custom fields' })).toBeNull(),
    );
  });
});

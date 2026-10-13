import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import type { ProductBundle } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const variant = (id: string, title = 'Default Title') => ({
  id,
  title,
  price: { amount: '6000.00', currencyCode: 'PKR' },
  compareAtPrice: null,
  sku: null,
  taxCode: null,
  selectedOptions: [],
  inventoryQuantity: 0,
  soldLast30Days: 0,
  daysOfStockLeft: null,
  inventoryItem: { id: `item_${id}`, tracked: true, inventoryPolicy: 'DENY', inventoryLevels: [] },
});

function product(bundle: ProductBundle | null, sized = false) {
  return {
    id: 'prod_1',
    title: 'Eid 3-piece suit',
    description: '',
    handle: 'eid-suit',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    bundle,
    options: sized
      ? [
          {
            id: 'opt_1',
            name: 'Size',
            optionValues: [
              { id: 'ov_1', name: 'S' },
              { id: 'ov_2', name: 'M' },
            ],
          },
        ]
      : [],
    media: [],
    variants: sized ? [variant('var_s', 'S'), variant('var_m', 'M')] : [variant('var_1')],
  };
}

const SHIRT = {
  id: 'prod_2',
  title: 'Lawn shirt',
  variants: [
    {
      id: 'var_shirt_m',
      title: 'M',
      availableForSale: true,
      inventoryQuantity: 4,
      price: { amount: '4000.00', currencyCode: 'PKR' },
    },
    {
      id: 'var_shirt_l',
      title: 'L',
      availableForSale: true,
      inventoryQuantity: 2,
      price: { amount: '4000.00', currencyCode: 'PKR' },
    },
  ],
};

const DUPATTA = {
  productId: 'prod_3',
  variantId: 'var_dupatta',
  productTitle: 'Chiffon dupatta',
  variantTitle: 'Default Title',
  quantity: 1,
};

function core(role: StaffRole, bundle: ProductBundle | null, sized = false) {
  let current = bundle;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          product: product(current, sized),
        };
      case 'DraftVariants':
        return { products: { nodes: [SHIRT] } };
      case 'ProductBundleSet': {
        const components = variables.components as { variantId: string; quantity: number }[];
        if (components.length === 1 && components[0]!.quantity === 1) {
          return {
            productBundleSet: {
              bundle: null,
              userErrors: [
                {
                  field: ['components'],
                  code: 'TOO_FEW',
                  message: 'A bundle holds two items at least: two variants, or two of one',
                },
              ],
            },
          };
        }
        current =
          components.length === 0
            ? null
            : {
                complete: true,
                components: components.map((part) =>
                  part.variantId === DUPATTA.variantId
                    ? { ...DUPATTA, quantity: part.quantity }
                    : {
                        productId: 'prod_2',
                        variantId: part.variantId,
                        productTitle: 'Lawn shirt',
                        variantTitle: part.variantId === 'var_shirt_m' ? 'M' : 'L',
                        quantity: part.quantity,
                      },
                ),
              };
        return { productBundleSet: { bundle: current, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'ProductBundleSet').map((each) => each.variables);

describe("A product's bundle on its page (CAT-11, ADR-409)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes a product a bundle of parts found by name, a number of each, and says what is wrong', async () => {
    const fake = core('owner', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    expect(await screen.findByText('Not a bundle: it sells as a product of its own.')).toBeTruthy();
    const save = () => screen.getByRole('button', { name: 'Save bundle' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add a part' }));
    fireEvent.change(screen.getByLabelText('Find products by name or SKU'), {
      target: { value: 'lawn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn shirt · M' }));
    // One of one part is no bundle: the core says so.
    fireEvent.click(save());
    expect(
      await screen.findByText('A bundle holds two items at least: two variants, or two of one'),
    ).toBeTruthy();

    // Two of it, then: a typo first.
    const quantity = screen.getByLabelText('How many of Lawn shirt · M') as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: '100' } });
    fireEvent.click(save());
    expect(await screen.findByText("Each part's quantity must be 1 to 99")).toBeTruthy();
    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.click(save());
    expect(await screen.findByText('Saved: it sells as a set of these parts')).toBeTruthy();
    expect(sentOf(fake)).toEqual([
      { productId: 'prod_1', components: [{ variantId: 'var_shirt_m', quantity: 1 }] },
      { productId: 'prod_1', components: [{ variantId: 'var_shirt_m', quantity: 2 }] },
    ]);
  });

  it('warns of a part deleted, and makes a bundle no bundle again', async () => {
    const fake = core('manager', { complete: false, components: [{ ...DUPATTA, quantity: 2 }] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    expect(
      await screen.findByText(
        "A part was deleted: it isn't sold until you give it its parts again.",
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText('How many of Chiffon dupatta') as HTMLInputElement).value).toBe(
      '2',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Chiffon dupatta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bundle' }));
    expect(
      await screen.findByText('No longer a bundle: it sells as a product of its own'),
    ).toBeTruthy();
    await waitFor(() => expect(sentOf(fake)).toEqual([{ productId: 'prod_1', components: [] }]));
  });

  it('is not offered for a product of options, nor to those who may not change products', async () => {
    vi.stubGlobal('fetch', core('owner', null, true).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid 3-piece suit' });
    expect(screen.queryByRole('button', { name: 'Save bundle' })).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', core('marketer', { complete: true, components: [DUPATTA] }).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid 3-piece suit' });
    expect(screen.queryByRole('button', { name: 'Save bundle' })).toBeNull();
  });
});

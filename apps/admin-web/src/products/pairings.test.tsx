import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

type Paired = { id: string; title: string };

function product(complementaryProducts: Paired[]) {
  return {
    id: 'prod_1',
    title: 'Lawn kurta',
    description: '',
    handle: 'lawn-kurta',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    complementaryProducts,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '4000.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: true,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

const DUPATTA = { id: 'prod_2', title: 'Chiffon dupatta' };
const KHUSSA = { id: 'prod_3', title: 'Khussa' };
const FOUND = [
  { ...DUPATTA, status: 'ACTIVE' },
  { ...KHUSSA, status: 'ACTIVE' },
  { id: 'prod_1', title: 'Lawn kurta', status: 'ACTIVE' },
];

function core(role: StaffRole, paired: Paired[]) {
  let current = paired;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'CollectionProductSearch':
        return { products: { nodes: FOUND } };
      case 'ProductComplementsSet': {
        const ids = variables.complementIds as string[];
        current = ids.map((id) => FOUND.find((each) => each.id === id)!);
        return {
          productComplementsSet: {
            complementaryProducts: current.map(({ id, title }) => ({ id, title })),
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'ProductComplementsSet')
    .map((each) => each.variables);

describe('The products a shop pairs with one, on its page (MKT-09, ADR-435)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pairs products found by name, in the order set, never itself or twice', async () => {
    const fake = core('owner', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    expect(
      await screen.findByText('None yet: its page shows related products alone.'),
    ).toBeTruthy();
    const save = () => screen.getByRole('button', { name: 'Save pairings' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add a product' }));
    fireEvent.change(screen.getByLabelText('Find a product to add'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chiffon dupatta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Khussa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn kurta' }));
    expect(screen.getByText("A product can't pair with itself")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Khussa' }));
    expect(screen.getByText('Khussa is in the list already')).toBeTruthy();
    // Khussas first.
    fireEvent.click(screen.getByRole('button', { name: 'Move Khussa up' }));
    fireEvent.click(save());
    expect(await screen.findByText('Saved: its page recommends these with it')).toBeTruthy();
    expect(sentOf(fake)).toEqual([{ productId: 'prod_1', complementIds: ['prod_3', 'prod_2'] }]);
  });

  it('pairs with none again, and is not offered to those who may not change products', async () => {
    const fake = core('manager', [DUPATTA, KHUSSA]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Chiffon dupatta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Khussa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save pairings' }));
    expect(await screen.findByText('Saved: it pairs with no products')).toBeTruthy();
    await waitFor(() => expect(sentOf(fake)).toEqual([{ productId: 'prod_1', complementIds: [] }]));
    cleanup();

    vi.stubGlobal('fetch', core('marketer', [DUPATTA]).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Lawn kurta' });
    expect(screen.queryByRole('button', { name: 'Save pairings' })).toBeNull();
  });
});

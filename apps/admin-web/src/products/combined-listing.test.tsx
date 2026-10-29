import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombinedListing } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(combinedListing: CombinedListing | null) {
  return {
    id: 'prod_1',
    title: 'Lawn suit, maroon',
    description: '',
    handle: 'lawn-suit-maroon',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    combinedListing,
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

const FOUND = [
  { id: 'prod_2', title: 'Lawn suit, teal', status: 'ACTIVE' },
  { id: 'prod_3', title: 'Lawn suit, mustard', status: 'ACTIVE' },
];

function core(role: StaffRole, listing: CombinedListing | null) {
  let current = listing;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'CollectionProductSearch':
        return { products: { nodes: FOUND } };
      case 'CombinedListingSet': {
        const input = variables.input as {
          optionName: string;
          optionNameUr: string | null;
          products: { productId: string; value: string; valueUr: string | null }[];
          oneCard: boolean;
        };
        if (input.products.some((each) => each.value === 'Teal' && each.productId === 'prod_3')) {
          return {
            combinedListingSet: {
              combinedListing: null,
              userErrors: [
                {
                  field: ['input', 'products', '1', 'productId'],
                  code: 'TAKEN',
                  message: 'This product is in another combined listing',
                },
              ],
            },
          };
        }
        const titles: Record<string, string> = {
          prod_1: 'Lawn suit, maroon',
          prod_2: 'Lawn suit, teal',
          prod_3: 'Lawn suit, mustard',
        };
        current = {
          id: 'cmbl_1',
          optionName: input.optionName,
          optionNameUr: input.optionNameUr,
          oneCard: input.oneCard,
          products: input.products.map((each) => ({
            ...each,
            product: { title: titles[each.productId]! },
          })),
        };
        return { combinedListingSet: { combinedListing: current, userErrors: [] } };
      }
      case 'CombinedListingDelete':
        current = null;
        return {
          combinedListingDelete: { deletedCombinedListingId: variables.id, userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("A product's combined listing, on its page (CAT-23, ADR-799)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('combines products found by name, each with its value, this one among them', async () => {
    const fake = core('owner', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    expect(
      await screen.findByText('Not in one: add the products this one comes in with.'),
    ).toBeTruthy();
    const save = () => screen.getByRole('button', { name: 'Save combined listing' });
    fireEvent.change(screen.getByLabelText('What they differ by'), { target: { value: 'Colour' } });
    fireEvent.change(screen.getByLabelText('Its value for Lawn suit, maroon'), {
      target: { value: 'Maroon' },
    });
    fireEvent.click(save());
    expect(screen.getByText('Add at least one other product')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add a product to combine' }));
    fireEvent.change(screen.getByLabelText('Find a product to add'), { target: { value: 'lawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn suit, mustard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn suit, mustard' }));
    expect(screen.getByText('Lawn suit, mustard is in the list already')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Its value for Lawn suit, mustard'), {
      target: { value: 'Teal' },
    });
    fireEvent.click(save());
    // The core's words, the product named.
    expect(
      await screen.findByText('Lawn suit, mustard: This product is in another combined listing'),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Its value for Lawn suit, mustard'), {
      target: { value: ' Mustard ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn suit, teal' }));
    fireEvent.change(screen.getByLabelText('Its value for Lawn suit, teal'), {
      target: { value: 'Teal' },
    });
    // Teal before mustard.
    fireEvent.click(screen.getByRole('button', { name: 'Move Lawn suit, teal up the listing' }));
    // In Urdu too (ADR-902).
    fireEvent.change(screen.getByLabelText('What they differ by, in Urdu'), {
      target: { value: ' رنگ ' },
    });
    fireEvent.change(screen.getByLabelText('Its value for Lawn suit, teal, in Urdu'), {
      target: { value: 'فیروزی' },
    });
    // One card in collections (ADR-901).
    fireEvent.click(screen.getByRole('checkbox', { name: /Show as one card in collections/ }));
    fireEvent.click(save());
    expect(await screen.findByText('Saved: each page offers the others')).toBeTruthy();
    expect(sentOf(fake, 'CombinedListingSet').at(-1)).toEqual({
      id: null,
      input: {
        optionName: 'Colour',
        optionNameUr: 'رنگ',
        products: [
          { productId: 'prod_1', value: 'Maroon', valueUr: null },
          { productId: 'prod_2', value: 'Teal', valueUr: 'فیروزی' },
          { productId: 'prod_3', value: 'Mustard', valueUr: null },
        ],
        oneCard: true,
      },
    });
    // This product cannot be taken out of its own listing; another can.
    expect(
      screen.queryByRole('button', { name: 'Take Lawn suit, maroon out of the listing' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Take Lawn suit, mustard out of the listing' }),
    );
    fireEvent.click(save());
    await waitFor(() =>
      expect(sentOf(fake, 'CombinedListingSet').at(-1)).toMatchObject({ id: 'cmbl_1' }),
    );
  });

  it('stops combining them, and is not offered to those who may not change products', async () => {
    const listing: CombinedListing = {
      id: 'cmbl_1',
      optionName: 'Colour',
      optionNameUr: 'رنگ',
      oneCard: true,
      products: [
        {
          productId: 'prod_2',
          value: 'Teal',
          valueUr: 'فیروزی',
          product: { title: 'Lawn suit, teal' },
        },
        {
          productId: 'prod_1',
          value: 'Maroon',
          valueUr: null,
          product: { title: 'Lawn suit, maroon' },
        },
      ],
    };
    const fake = core('manager', listing);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(
      ((await screen.findByLabelText('Its value for Lawn suit, teal')) as HTMLInputElement).value,
    ).toBe('Teal');
    expect(
      (screen.getByRole('checkbox', { name: /Show as one card/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText('Its value for Lawn suit, teal, in Urdu') as HTMLInputElement).value,
    ).toBe('فیروزی');
    fireEvent.click(screen.getByRole('button', { name: 'Stop combining them' }));
    expect(await screen.findByText('They are shown on their own again')).toBeTruthy();
    expect(sentOf(fake, 'CombinedListingDelete')).toEqual([{ id: 'cmbl_1' }]);
    expect(screen.queryByRole('button', { name: 'Stop combining them' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('marketer', listing).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Lawn suit, maroon' });
    expect(screen.queryByRole('button', { name: 'Save combined listing' })).toBeNull();
  });
});

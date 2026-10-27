import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductStitching } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(stitching: ProductStitching | null) {
  return {
    id: 'prod_1',
    title: 'Unstitched lawn 3-piece',
    description: '',
    handle: 'unstitched-lawn',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    stitching,
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

function core(role: StaffRole, stitching: ProductStitching | null) {
  let current = stitching;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'ProductStitchingSet': {
        const given = variables.stitching as {
          price: string;
          leadDays: number;
          measurements: string[];
        } | null;
        if (given && given.leadDays > 60) {
          return {
            productStitchingSet: {
              stitching: null,
              userErrors: [
                {
                  field: ['input', 'leadDays'],
                  code: 'INVALID',
                  message: 'must be a whole number from 1 to 60',
                },
              ],
            },
          };
        }
        current = given && {
          price: { amount: `${given.price}.00` },
          leadDays: given.leadDays,
          measurements: given.measurements.map((key) => ({ key })),
        };
        return { productStitchingSet: { stitching: current, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent
    .filter((each) => each.operation === 'ProductStitchingSet')
    .map((each) => each.variables);

describe("A product's stitching, on its page (CAT-09, ADR-802)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers it stitched for a price and days, asking for the measurements chosen', async () => {
    const fake = core('owner', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const save = () => screen.getByRole('button', { name: 'Save stitching' }) as HTMLButtonElement;
    fireEvent.click(
      await screen.findByLabelText("Offer it stitched to the shopper's measurements"),
    );
    fireEvent.change(screen.getByLabelText('What stitching adds (Rs)'), {
      target: { value: '1,500' },
    });
    fireEvent.change(screen.getByLabelText('Days it adds before shipping'), {
      target: { value: '90' },
    });
    // The usual measurements are chosen until the shop says otherwise.
    expect((screen.getByLabelText('Chest') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Neck') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(save());
    expect(await screen.findByText(/must be a whole number from 1 to 60/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Days it adds before shipping'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByLabelText('Hips'));
    fireEvent.click(screen.getByLabelText('Neck'));
    fireEvent.click(save());
    expect(await screen.findByText('Saved: its page offers it stitched')).toBeTruthy();
    expect(sentOf(fake).at(-1)).toEqual({
      productId: 'prod_1',
      stitching: {
        price: '1500',
        leadDays: 7,
        // In the order tailors take them.
        measurements: [
          'shirt_length',
          'chest',
          'waist',
          'shoulder',
          'sleeve_length',
          'neck',
          'trouser_length',
        ],
      },
    });
    expect(save().disabled).toBe(true);
  });

  it('stops offering it, and is not offered to those who may not change products', async () => {
    const offered = {
      price: { amount: '1500.00' },
      leadDays: 7,
      measurements: [{ key: 'chest' }],
    };
    const fake = core('manager', offered);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(
      ((await screen.findByLabelText('What stitching adds (Rs)')) as HTMLInputElement).value,
    ).toBe('1500');
    fireEvent.click(screen.getByLabelText("Offer it stitched to the shopper's measurements"));
    fireEvent.click(screen.getByRole('button', { name: 'Save stitching' }));
    expect(await screen.findByText('Saved: it is sold unstitched alone')).toBeTruthy();
    await waitFor(() => expect(sentOf(fake)).toEqual([{ productId: 'prod_1', stitching: null }]));
    cleanup();

    vi.stubGlobal('fetch', core('marketer', offered).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Unstitched lawn 3-piece' });
    expect(screen.queryByRole('button', { name: 'Save stitching' })).toBeNull();
  });
});

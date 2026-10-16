import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(isGiftCard: boolean) {
  return {
    id: 'prod_1',
    title: 'Eid gift card',
    description: '',
    handle: 'eid-gift-card',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard,
    preorder: null,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '5000.00', currencyCode: 'PKR' },
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

/** A core that refuses the change once `refuse` is set. */
function core(role: StaffRole, isGiftCard: boolean, refuse = false) {
  let current = isGiftCard;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'ProductUpdate': {
        if (refuse) {
          return {
            productUpdate: {
              product: null,
              userErrors: [{ field: ['input', 'giftCard'], code: 'INVALID', message: 'not now' }],
            },
          };
        }
        current = (variables.input as { giftCard: boolean }).giftCard;
        return { productUpdate: { product: { id: 'prod_1' }, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'ProductUpdate').map((each) => each.variables);

describe('A product sold as a gift card, on its page (CAT-12, ADR-451)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sells a product as a gift card at once, and stops', async () => {
    const fake = core('owner', false);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const box = (await screen.findByLabelText(/Sell as a gift card/)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([{ input: { id: 'prod_1', giftCard: true } }]),
    );
    await waitFor(() =>
      expect((screen.getByLabelText(/Sell as a gift card/) as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(screen.getByLabelText(/Sell as a gift card/));
    await waitFor(() =>
      expect(sentOf(fake).at(-1)).toEqual({ input: { id: 'prod_1', giftCard: false } }),
    );
  });

  it('puts the box back and says why when the core refuses', async () => {
    vi.stubGlobal('fetch', core('manager', true, true).fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const box = (await screen.findByLabelText(/Sell as a gift card/)) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(await screen.findByText(/not now/)).toBeTruthy();
    expect((screen.getByLabelText(/Sell as a gift card/) as HTMLInputElement).checked).toBe(true);
  });
});

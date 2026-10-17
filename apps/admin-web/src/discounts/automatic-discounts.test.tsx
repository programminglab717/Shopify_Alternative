import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticDiscountValue } from '../api/types';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const automatic = (overrides: Partial<AutomaticDiscountValue>): AutomaticDiscountValue => ({
  id: 'dsa_1',
  title: 'Eid sale',
  kind: 'PERCENTAGE',
  summary: '10% off orders of Rs 3,000 or more',
  status: 'ACTIVE',
  combinesWithCodes: false,
  startsAt: LATER,
  endsAt: null,
  ...overrides,
});

describe('Automatic discounts in the admin (ADR-515)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts one for a percentage off from a minimum, codes going with it, as a marketer', async () => {
    const discounts: AutomaticDiscountValue[] = [];
    const core = fakeCore('marketer', (operation) => {
      if (operation === 'DiscountCodes') return { discountCodes: { nodes: [] } };
      if (operation === 'AutomaticDiscounts') return { automaticDiscounts: discounts };
      if (operation === 'AutomaticDiscountCreate') {
        const made = automatic({ combinesWithCodes: true });
        discounts.push(made);
        return { automaticDiscountCreate: { automaticDiscount: made, userErrors: [] } };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('No automatic discounts yet.');
    await press('New automatic discount');
    type('Title shoppers see', ' Eid sale ');
    type('Percentage off', '10');
    type('For orders from (optional)', '3,000');
    fireEvent.click(screen.getByRole('checkbox', { name: /Codes can be used with it/ }));
    type('Ends (optional)', '2026-12-31');
    await press('Start it');

    await screen.findByText('Eid sale is set: carts take it while it runs.');
    const section = screen.getByRole('region', { name: 'Automatic discounts' });
    expect(within(section).getByText('10% off orders of Rs 3,000 or more')).toBeTruthy();
    expect(
      core.sent.find((each) => each.operation === 'AutomaticDiscountCreate')?.variables,
    ).toEqual({
      automaticDiscount: {
        title: 'Eid sale',
        percentage: 10,
        minimumSubtotal: '3,000',
        combinesWithCodes: true,
        endsAt: '2026-12-31T18:59:59.000Z',
      },
    });
  });

  it('ends one at once and deletes another; staff who make no discounts only see them', async () => {
    const answer = (operation: string) => {
      switch (operation) {
        case 'DiscountCodes':
          return { discountCodes: { nodes: [] } };
        case 'AutomaticDiscounts':
          return {
            automaticDiscounts: [
              automatic({}),
              automatic({
                id: 'dsa_2',
                title: 'Free delivery week',
                kind: 'FREE_SHIPPING',
                summary: 'Free delivery',
                status: 'EXPIRED',
              }),
            ],
          };
        case 'AutomaticDiscountUpdate':
          return {
            automaticDiscountUpdate: { automaticDiscount: { id: 'dsa_1' }, userErrors: [] },
          };
        case 'AutomaticDiscountDelete':
          return {
            automaticDiscountDelete: { deletedAutomaticDiscountId: 'dsa_2', userErrors: [] },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    };
    const core = fakeCore('manager', answer);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('Free delivery week');
    expect(screen.getAllByRole('button', { name: 'End it now' })).toHaveLength(1);
    await press('End it now');
    await waitFor(() =>
      expect(
        core.sent.find((each) => each.operation === 'AutomaticDiscountUpdate')?.variables,
      ).toEqual({ id: 'dsa_1', automaticDiscount: { endsAt: expect.any(String) } }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    expect(screen.getByText('Orders placed with it keep its title.')).toBeTruthy();
    await press('Delete it');
    await waitFor(() =>
      expect(
        core.sent.find((each) => each.operation === 'AutomaticDiscountDelete')?.variables,
      ).toEqual({ id: 'dsa_2' }),
    );
    cleanup();

    // The discounts page is not an accountant's; an owner sees and changes them like a manager.
    vi.stubGlobal('fetch', fakeCore('owner', answer).fetcher);
    renderAdmin('/shop_1/discounts');
    await screen.findByText('Free delivery week');
    expect(screen.getByRole('button', { name: 'New automatic discount' })).toBeTruthy();
  });
  it('starts one for some products and collections, chosen by name, or says to choose one (ADR-518)', async () => {
    const core = fakeCore('owner', (operation, variables) => {
      if (operation === 'DiscountCodes') return { discountCodes: { nodes: [] } };
      if (operation === 'AutomaticDiscounts') return { automaticDiscounts: [] };
      if (operation === 'Collections') {
        return {
          collections: {
            nodes: [
              { id: 'col_1', title: 'Eid edit', productsCount: 12, ruleSet: null },
              { id: 'col_2', title: 'Footwear', productsCount: 4, ruleSet: null },
            ],
          },
        };
      }
      if (operation === 'CollectionProductSearch') {
        expect(variables).toEqual({ query: 'lawn' });
        return {
          products: {
            nodes: [
              { id: 'prod_1', title: 'Lawn 3-piece', status: 'ACTIVE' },
              { id: 'prod_2', title: 'Lawn dupatta', status: 'ACTIVE' },
            ],
          },
        };
      }
      if (operation === 'AutomaticDiscountCreate') {
        return {
          automaticDiscountCreate: {
            automaticDiscount: automatic({ summary: '20% off 1 product and 1 collection' }),
            userErrors: [],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('No automatic discounts yet.');
    await press('New automatic discount');
    type('Title shoppers see', 'Eid sale');
    type('Percentage off', '20');
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'SOME' } });
    await press('Start it');
    expect(
      screen.getByText('Choose a product or collection, or make it for the whole order.'),
    ).toBeTruthy();
    expect(core.sent.some((each) => each.operation === 'AutomaticDiscountCreate')).toBe(false);

    type('Find a product to add', 'lawn');
    fireEvent.keyDown(screen.getByLabelText('Find a product to add'), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Add Lawn 3-piece' });
    await press('Add Lawn 3-piece');
    await press('Add Lawn dupatta');
    // One chosen is not offered again, and is taken off with its button.
    expect(screen.queryByRole('button', { name: 'Add Lawn 3-piece' })).toBeNull();
    await press('Take off Lawn dupatta');
    fireEvent.change(await screen.findByLabelText('Add a collection'), {
      target: { value: 'col_1' },
    });
    const chosen = screen.getByRole('list', { name: 'Chosen products and collections' });
    expect(within(chosen).getByText('Eid edit (collection)')).toBeTruthy();
    await press('Start it');

    await screen.findByText('Eid sale is set: carts take it while it runs.');
    expect(
      core.sent.find((each) => each.operation === 'AutomaticDiscountCreate')?.variables,
    ).toEqual({
      automaticDiscount: {
        title: 'Eid sale',
        percentage: 20,
        minimumSubtotal: null,
        combinesWithCodes: false,
        endsAt: null,
        productIds: ['prod_1'],
        collectionIds: ['col_1'],
      },
    });
  });
  it('starts a buy 2 get 1 free for a collection (ADR-520)', async () => {
    const core = fakeCore('marketer', (operation) => {
      if (operation === 'DiscountCodes') return { discountCodes: { nodes: [] } };
      if (operation === 'AutomaticDiscounts') return { automaticDiscounts: [] };
      if (operation === 'Collections') {
        return {
          collections: { nodes: [{ id: 'col_1', title: 'Lawn', productsCount: 9, ruleSet: null }] },
        };
      }
      if (operation === 'AutomaticDiscountCreate') {
        return {
          automaticDiscountCreate: {
            automaticDiscount: automatic({
              title: 'Lawn: buy 2 get 1',
              kind: 'BUY_X_GET_Y',
              summary: 'Buy 2, get 1 free of 1 collection',
            }),
            userErrors: [],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('No automatic discounts yet.');
    await press('New automatic discount');
    type('Title shoppers see', 'Lawn: buy 2 get 1');
    fireEvent.change(screen.getByLabelText('It gives'), { target: { value: 'BUY_X_GET_Y' } });
    // Free unless less is given, two bought for one given unless changed.
    expect(
      (screen.getByLabelText('Percentage off the items given') as HTMLInputElement).value,
    ).toBe('100');
    expect((screen.getByLabelText('Items bought') as HTMLInputElement).value).toBe('2');
    type('Items given', '1');
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'SOME' } });
    fireEvent.change(await screen.findByLabelText('Add a collection'), {
      target: { value: 'col_1' },
    });
    await press('Start it');

    await screen.findByText('Lawn: buy 2 get 1 is set: carts take it while it runs.');
    expect(
      core.sent.find((each) => each.operation === 'AutomaticDiscountCreate')?.variables,
    ).toEqual({
      automaticDiscount: {
        title: 'Lawn: buy 2 get 1',
        buyQuantity: 2,
        getQuantity: 1,
        percentage: 100,
        minimumSubtotal: null,
        combinesWithCodes: false,
        endsAt: null,
        productIds: [],
        collectionIds: ['col_1'],
      },
    });
  });
});

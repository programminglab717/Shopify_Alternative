import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { pakistanToday, shipsOnWords } from './preorder';

function product(preorder: { shipsOn: string } | null) {
  return {
    id: 'prod_1',
    title: 'Eid Kurta',
    description: '',
    handle: 'eid-kurta',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    preorder,
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '4999.00', currencyCode: 'PKR' },
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

function core(role: StaffRole, preorder: { shipsOn: string } | null) {
  let current = preorder;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Product':
        return { location: { id: 'loc_1', name: 'Main location' }, product: product(current) };
      case 'ProductPreorderSet': {
        if (variables.shipsOn === '2099-01-01') {
          return {
            productPreorderSet: {
              preorder: null,
              userErrors: [
                { field: ['shipsOn'], code: 'INVALID', message: 'must be within a year' },
              ],
            },
          };
        }
        current = variables.shipsOn ? { shipsOn: variables.shipsOn as string } : null;
        return {
          productPreorderSet: {
            preorder: current && { productId: 'prod_1', shipsOn: current.shipsOn },
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
  fake.sent.filter((each) => each.operation === 'ProductPreorderSet').map((each) => each.variables);

describe("A product's pre-order on its page (CAT-14, ADR-403)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts a product on pre-order with the day it ships by, a month ahead to begin with', async () => {
    const fake = core('owner', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const box = (await screen.findByLabelText(/Take pre-orders/)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByLabelText('Ships by')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Save pre-order' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(box);
    const day = screen.getByLabelText('Ships by') as HTMLInputElement;
    expect(day.value).toBe(pakistanToday(new Date(), 30));
    expect(day.min).toBe(pakistanToday());
    expect(day.max).toBe(pakistanToday(new Date(), 365));
    fireEvent.change(day, { target: { value: pakistanToday(new Date(), 40) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pre-order' }));
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([
        { productId: 'prod_1', shipsOn: pakistanToday(new Date(), 40) },
      ]),
    );
    const words = shipsOnWords(pakistanToday(new Date(), 40), 'en');
    expect(await screen.findByText(`On pre-order, shipping by ${words}`)).toBeTruthy();
  });

  it('takes a product off pre-order, and says why a day was refused', async () => {
    const fake = core('manager', { shipsOn: pakistanToday(new Date(), 10) });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const day = (await screen.findByLabelText('Ships by')) as HTMLInputElement;
    fireEvent.change(day, { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save pre-order' }));
    expect(await screen.findByText(/must be within a year/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Take pre-orders/));
    fireEvent.click(screen.getByRole('button', { name: 'Save pre-order' }));
    expect(
      await screen.findByText('No longer on pre-order: it sells as its stock allows'),
    ).toBeTruthy();
    expect(sentOf(fake).at(-1)).toEqual({ productId: 'prod_1', shipsOn: null });
  });

  it('warns of a day gone by, which customers are still told', async () => {
    vi.stubGlobal('fetch', core('owner', { shipsOn: '2026-01-05' }).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    expect(
      await screen.findByText(
        `Its day, ${shipsOnWords('2026-01-05', 'en')}, has gone by: customers are still told it ships by then. Move the day, or stop taking pre-orders.`,
      ),
    ).toBeTruthy();
  });

  it('is not offered to those who may not change products', async () => {
    vi.stubGlobal('fetch', core('marketer', { shipsOn: pakistanToday(new Date(), 10) }).fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Eid Kurta' });
    expect(screen.queryByLabelText(/Take pre-orders/)).toBeNull();
  });
});

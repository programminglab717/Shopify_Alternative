import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import type { PriceSale } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const LAWN = { id: 'prod_1', title: 'Lawn suit' };
const SHAWL = { id: 'prod_2', title: 'Pashmina shawl' };
const FOUND = [
  { ...LAWN, status: 'ACTIVE' },
  { ...SHAWL, status: 'ACTIVE' },
];
const RUNNING: PriceSale = {
  id: 'sale_1',
  name: 'Flash sale',
  percentOff: 30,
  status: 'RUNNING',
  startsAt: '2026-10-16T19:00:00Z',
  endsAt: '2026-10-18T19:00:00Z',
  endedAt: null,
  productsCount: 2,
  products: [LAWN, SHAWL],
};

function core(role: StaffRole, sales: PriceSale[]) {
  let current = sales;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'PriceSales':
        return { priceSales: current };
      case 'CollectionProductSearch':
        return { products: { nodes: FOUND } };
      case 'PriceSaleCreate': {
        const input = variables.input as {
          name: string;
          percentOff: number;
          startsAt: string;
          endsAt: string;
          productIds: string[];
        };
        if (input.name === 'Clash') {
          return {
            priceSaleCreate: {
              priceSale: null,
              userErrors: [
                {
                  field: ['productIds', '0'],
                  code: 'TAKEN',
                  message: 'It is in the sale "Flash sale" for some of these days',
                },
              ],
            },
          };
        }
        const made: PriceSale = {
          id: 'sale_2',
          name: input.name,
          percentOff: input.percentOff,
          status: 'SCHEDULED',
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          endedAt: null,
          productsCount: input.productIds.length,
          products: FOUND.filter((each) => input.productIds.includes(each.id)).map(
            ({ id, title }) => ({ id, title }),
          ),
        };
        current = [made, ...current];
        return { priceSaleCreate: { priceSale: made, userErrors: [] } };
      }
      case 'PriceSaleCancel': {
        current = current.map((each) =>
          each.id === variables.id
            ? {
                ...each,
                status: each.status === 'RUNNING' ? 'ENDED' : 'CANCELLED',
                endedAt: each.status === 'RUNNING' ? '2026-10-17T10:00:00Z' : null,
              }
            : each,
        );
        return {
          priceSaleCancel: {
            priceSale: current.find((each) => each.id === variables.id),
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

/** Fills in the form for a sale of the products named. */
async function fill(name: string, titles: string[]) {
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Percentage off'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2026-11-10T00:00' } });
  fireEvent.change(screen.getByLabelText('Ends at'), { target: { value: '2026-11-12T23:59' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add a product' }));
  fireEvent.change(screen.getByLabelText('Find a product to add'), { target: { value: 'a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  for (const title of titles) {
    fireEvent.click(await screen.findByRole('button', { name: `Add ${title}` }));
  }
}

describe("The admin's sales set ahead (CAT-17, ADR-444)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sets a sale of products found by name, then cancels it', async () => {
    const fake = core('owner', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/sales');

    expect(await screen.findByText('No sales yet')).toBeTruthy();
    const set = () => screen.getByRole('button', { name: 'Set sale' }) as HTMLButtonElement;
    expect(set().disabled).toBe(true);
    await fill('Eid sale', ['Lawn suit', 'Pashmina shawl', 'Lawn suit']);
    expect(screen.getByText('Lawn suit is in the list already')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pashmina shawl' }));
    fireEvent.click(set());
    expect(await screen.findByText('Eid sale is set.')).toBeTruthy();
    expect(sentOf(fake, 'PriceSaleCreate')).toEqual([
      {
        input: {
          name: 'Eid sale',
          percentOff: 20,
          startsAt: new Date('2026-11-10T00:00').toISOString(),
          endsAt: new Date('2026-11-12T23:59').toISOString(),
          productIds: ['prod_1'],
        },
      },
    ]);
    expect(await screen.findByText('20% off 1 product')).toBeTruthy();
    expect(screen.getByText('Set ahead')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sale' }));
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(sentOf(fake, 'PriceSaleCancel')).toEqual([{ id: 'sale_2' }]);
  });

  it('names the product the core refuses, and ends a running sale early', async () => {
    const fake = core('manager', [RUNNING]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/sales');

    expect(await screen.findByText('30% off 2 products')).toBeTruthy();
    expect(screen.getByText('Lawn suit, Pashmina shawl')).toBeTruthy();
    await fill('Clash', ['Lawn suit']);
    fireEvent.click(screen.getByRole('button', { name: 'Set sale' }));
    expect(
      await screen.findByText('Lawn suit: It is in the sale "Flash sale" for some of these days'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End now' }));
    expect(await screen.findByText('Ended')).toBeTruthy();
    await waitFor(() => expect(sentOf(fake, 'PriceSaleCancel')).toEqual([{ id: 'sale_1' }]));
  });

  it('shows sales to those who may not change products, with nothing to change', async () => {
    vi.stubGlobal('fetch', core('marketer', [RUNNING]).fetcher);
    renderAdmin('/shop_1/products/sales');
    expect(await screen.findByText('Flash sale')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
  });
});

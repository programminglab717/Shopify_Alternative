import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { measurementOf } from './size-charts';

const KURTAS = {
  id: 'szc_1',
  name: 'Kurtas',
  unit: 'INCHES',
  columns: ['Chest', 'Length'],
  rows: [
    { size: 'S', values: [36, 42] },
    { size: 'M', values: [38.5, null] },
  ],
  note: 'Measure a kurta that fits.',
  productsCount: 3,
};

const SHIRTS = { ...KURTAS, id: 'szc_2', name: 'Shirts', unit: 'CENTIMETERS', productsCount: 1 };

function product(sizeChart: { id: string; name: string } | null) {
  return {
    id: 'prod_1',
    title: 'Lawn Kurta',
    description: '',
    handle: 'lawn-kurta',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    preorder: null,
    sizeChart,
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

function core(role: StaffRole, charts = [KURTAS, SHIRTS]) {
  let shown: { id: string; name: string } | null = null;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'SizeCharts':
        return { sizeCharts: charts };
      case 'SizeChart':
        return { sizeChart: charts.find((chart) => chart.id === variables.id) ?? null };
      case 'SizeChartCreate': {
        const input = variables.input as typeof KURTAS;
        if (input.name === 'Kurtas') {
          return {
            sizeChartCreate: {
              sizeChart: null,
              userErrors: [
                { field: ['name'], code: 'TAKEN', message: 'is the name of another chart' },
                {
                  field: ['rows', '1', 'values', '0'],
                  code: 'INVALID',
                  message: 'A measurement must be more than 0 and at most 999',
                },
              ],
            },
          };
        }
        return {
          sizeChartCreate: {
            sizeChart: { ...input, id: 'szc_9', productsCount: 0 },
            userErrors: [],
          },
        };
      }
      case 'SizeChartUpdate':
        return {
          sizeChartUpdate: {
            sizeChart: { ...(variables.input as object), id: variables.id, productsCount: 3 },
            userErrors: [],
          },
        };
      case 'SizeChartDelete':
        return { sizeChartDelete: { deletedSizeChartId: variables.id, userErrors: [] } };
      case 'Collections':
        return {
          collections: {
            nodes: [{ id: 'col_1', title: 'Eid', productsCount: 4, ruleSet: null }],
          },
        };
      case 'ProductsSizeChartSet':
        if (variables.sizeChartId) {
          shown = charts.find((chart) => chart.id === variables.sizeChartId) ?? null;
        } else shown = null;
        return {
          productsSizeChartSet: {
            productIds: variables.collectionId ? ['prod_1', 'prod_2', 'prod_3'] : ['prod_1'],
            userErrors: [],
          },
        };
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          product: product(shown && { id: shown.id, name: shown.name }),
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Size charts in the admin (CAT-10, ADR-406)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reads a measurement as typed: blank for none, a comma for a point, words refused', () => {
    expect(measurementOf(' 38.5 ')).toBe(38.5);
    expect(measurementOf('38,5')).toBe(38.5);
    expect(measurementOf('')).toBeNull();
    expect(measurementOf('forty')).toBeUndefined();
  });

  it("lists the shop's charts with their sizes and products, or says there are none", async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/products/size-charts');
    expect(await screen.findByRole('link', { name: 'Kurtas' })).toBeTruthy();
    expect(screen.getAllByText('S, M · Chest, Length, in Inches')).toHaveLength(1);
    expect(screen.getByText('Shown on 3 products')).toBeTruthy();
    expect(screen.getByText('Shown on 1 product')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add size chart' })).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('marketer', []).fetcher);
    renderAdmin('/shop_1/products/size-charts');
    expect(await screen.findByText('No size charts yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add size chart' })).toBeNull();
  });

  it('makes a chart of sizes and measurements, and says what is wrong with one', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/size-charts/new');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Kurtas' } });
    fireEvent.change(screen.getByLabelText('Measurement 1'), { target: { value: 'Chest' } });
    fireEvent.change(screen.getByLabelText('Measurement 2'), { target: { value: 'Length' } });
    fireEvent.change(screen.getByLabelText('Size 1'), { target: { value: 'S' } });
    fireEvent.change(screen.getByLabelText('Size 2'), { target: { value: 'M' } });
    fireEvent.change(screen.getByLabelText('Chest of size S'), { target: { value: '36' } });
    fireEvent.change(screen.getByLabelText('Length of size S'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Chest of size M'), { target: { value: 'forty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create size chart' }));
    expect(await screen.findByText('Size M, Chest: must be a number, like 38.5')).toBeTruthy();
    expect(sentOf(fake, 'SizeChartCreate')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Chest of size M'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create size chart' }));
    expect(await screen.findByText('Name: is the name of another chart')).toBeTruthy();
    expect(screen.getByText('Size M, Chest: must be more than 0 and at most 999')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kurtas, women' } });
    fireEvent.change(screen.getByLabelText('Chest of size M'), { target: { value: '38,5' } });
    fireEvent.change(screen.getByLabelText('Written in'), { target: { value: 'CENTIMETERS' } });
    fireEvent.change(screen.getByLabelText('How to measure'), {
      target: { value: 'Measure a kurta that fits.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create size chart' }));
    await waitFor(() =>
      expect(sentOf(fake, 'SizeChartCreate').at(-1)).toEqual({
        input: {
          name: 'Kurtas, women',
          unit: 'CENTIMETERS',
          columns: ['Chest', 'Length'],
          rows: [
            { size: 'S', values: [36, 42] },
            { size: 'M', values: [38.5, null] },
          ],
          note: 'Measure a kurta that fits.',
        },
      }),
    );
  });

  it('changes a chart, a size and a measurement added and one taken away, then deletes it', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/size-charts/szc_1');

    expect(await screen.findByRole('heading', { name: 'Kurtas' })).toBeTruthy();
    expect((screen.getByLabelText('Length of size M') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add a size' }));
    fireEvent.change(screen.getByLabelText('Size 3'), { target: { value: 'L' } });
    fireEvent.change(screen.getByLabelText('Chest of size L'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a measurement' }));
    fireEvent.change(screen.getByLabelText('Measurement 3'), { target: { value: 'Shoulder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Length' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove size S' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save size chart' }));
    await waitFor(() =>
      expect(sentOf(fake, 'SizeChartUpdate')).toEqual([
        {
          id: 'szc_1',
          input: {
            name: 'Kurtas',
            unit: 'INCHES',
            columns: ['Chest', 'Shoulder'],
            rows: [
              { size: 'M', values: [38.5, null] },
              { size: 'L', values: [40, null] },
            ],
            note: 'Measure a kurta that fits.',
          },
        },
      ]),
    );
    expect(await screen.findByText('Saved. Products showing it show it changed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete size chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('link', { name: 'Shirts' })).toBeTruthy();
    expect(sentOf(fake, 'SizeChartDelete')).toEqual([{ id: 'szc_1' }]);
  });

  it("gives a chart to a collection's products", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/size-charts/szc_1');
    const section = (
      await screen.findByRole('heading', { name: "Give it to a collection's products" })
    ).closest('section')!;
    await within(section).findByRole('option', { name: 'Eid (4)' });
    fireEvent.change(within(section).getByLabelText('Collection'), { target: { value: 'col_1' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Give to these products' }));
    expect(await screen.findByText('3 products given it')).toBeTruthy();
    expect(sentOf(fake, 'ProductsSizeChartSet')).toEqual([
      { sizeChartId: 'szc_1', collectionId: 'col_1' },
    ]);
  });

  it("chooses a product's chart on its page, or none, for those who change products", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');
    const chart = (await screen.findByLabelText('Chart')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Shirts' });
    expect(chart.value).toBe('');
    fireEvent.change(chart, { target: { value: 'szc_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save size chart' }));
    expect(await screen.findByText('Its page shows this size chart.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Chart'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save size chart' }));
    expect(await screen.findByText('Its page shows no size chart.')).toBeTruthy();
    expect(sentOf(fake, 'ProductsSizeChartSet')).toEqual([
      { sizeChartId: 'szc_2', productIds: ['prod_1'] },
      { sizeChartId: null, productIds: ['prod_1'] },
    ]);
    cleanup();

    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Lawn Kurta' });
    expect(screen.queryByLabelText('Chart')).toBeNull();
  });
});

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const PRODUCTS = 'Handle,Title\nlawn-suit,Lawn Suit\n';
const COUNT = 'Handle,Location,On hand (new)\nlawn-suit,Lahore warehouse,12\n';

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Products':
        return { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      case 'ProductsImport': {
        const update = variables.overwrite === true;
        return {
          productsImport: {
            dryRun: variables.dryRun,
            rows: 6,
            created: 2,
            updated: update ? 1 : 0,
            skipped: update ? 0 : 1,
            variants: 7,
            images: 3,
            stocked: 7,
            rowErrorCount: 1,
            rowErrors: [{ row: 6, column: 'Variant Price', message: 'is not an amount' }],
            userErrors: [],
          },
        };
      }
      case 'ProductsExport':
        return { productsExport: { csv: PRODUCTS, productCount: 1, rowCount: 1 } };
      case 'Locations':
        return {
          locations: {
            nodes: [
              { id: 'loc_1', name: 'Lahore warehouse', isPrimary: true },
              { id: 'loc_2', name: 'Karachi shop', isPrimary: false },
            ],
          },
        };
      case 'InventoryExport':
        return { inventoryExport: { csv: COUNT, productCount: 1, rowCount: 4 } };
      case 'InventoryImport':
        return {
          inventoryImport: {
            dryRun: variables.dryRun,
            rows: 4,
            counted: 3,
            unchanged: 1,
            rowErrorCount: 0,
            rowErrors: [],
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const choose = async (label: string, name: string, csv: string) =>
  act(async () =>
    fireEvent.change(await screen.findByLabelText(label), {
      target: { files: [new File([csv], name, { type: 'text/csv' })] },
    }),
  );

describe('Products and stock by file', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('checks a product CSV first, then imports it, updating those the shop has when asked', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');

    fireEvent.click(await screen.findByRole('link', { name: 'Import and export' }));
    await choose('Products file', 'products_export.csv', PRODUCTS);
    expect(
      await screen.findByText(
        'products_export.csv, rows: 6. Products to add: 2; to update: 0; to leave as they are: 1. Variants to make: 7.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Row 6, Variant Price: is not an amount')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Update products I have already/));
    expect(
      await screen.findByText(/Products to add: 2; to update: 1; to leave as they are: 0\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import them' }));
    expect(
      await screen.findByText(
        'Imported. Products added: 2; updated: 1; left as they were: 0. Images: 3. Variants given stock: 7.',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'ProductsImport')).toEqual([
      { csv: PRODUCTS, dryRun: true, overwrite: false },
      { csv: PRODUCTS, dryRun: true, overwrite: true },
      { csv: PRODUCTS, dryRun: false, overwrite: true },
    ]);
  });

  it("downloads products a search finds, and one location's stock, then counts a filled-in file", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/products/files');

    await screen.findByLabelText('Which products');
    type('Which products', 'tag:eid');
    fireEvent.click(await screen.findByRole('button', { name: 'Download products' }));
    expect(await screen.findByText('Saved. Products: 1; rows: 1.')).toBeTruthy();
    expect(sentOf(fake, 'ProductsExport')).toEqual([{ query: 'tag:eid' }]);

    await screen.findByRole('option', { name: 'Karachi shop' });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download stock' }));
    expect(await screen.findByText('Saved. Rows to count: 4.')).toBeTruthy();
    expect(sentOf(fake, 'InventoryExport')).toEqual([{ locationId: 'loc_2' }]);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect((click.mock.contexts[1] as HTMLAnchorElement).download).toBe('inventory_export.csv');

    await choose('Stock count file', 'counted.csv', COUNT);
    expect(
      await screen.findByText('counted.csv, rows: 4. To count: 3; to leave as they are: 1.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Count them' }));
    expect(await screen.findByText('Counted: 3; left as they were: 1.')).toBeTruthy();
    expect(sentOf(fake, 'InventoryImport')).toEqual([
      { csv: COUNT, dryRun: true },
      { csv: COUNT, dryRun: false },
    ]);
  });

  it('is not there for a packer', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/products/files');
    expect(
      await screen.findByText('Owners and managers bring products in and out by file.'),
    ).toBeTruthy();
  });
});

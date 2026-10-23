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
      case 'ProductsImportFromShopify':
        if (variables.store === 'zari.pk') {
          return {
            productsImportFromShopify: {
              dryRun: true,
              rows: 0,
              created: 0,
              updated: 0,
              skipped: 0,
              variants: 0,
              images: 0,
              stocked: 0,
              rowErrorCount: 0,
              rowErrors: [],
              userErrors: [
                {
                  field: ['store'],
                  code: 'INVALID',
                  message: "Give the store's address at Shopify, as zari.myshopify.com",
                },
              ],
            },
          };
        }
        return {
          productsImportFromShopify: {
            dryRun: variables.dryRun,
            rows: 9,
            created: 4,
            updated: 0,
            skipped: 0,
            variants: 9,
            images: 5,
            stocked: 9,
            rowErrorCount: 1,
            rowErrors: [
              {
                row: 7,
                column: 'Image Src',
                handle: 'lawn-suit',
                message: 'is not an https address',
              },
            ],
            userErrors: [],
          },
        };
      case 'UrlRedirectsImportFromShopify':
        return {
          urlRedirectsImportFromShopify: {
            dryRun: variables.dryRun,
            rows: 3,
            created: 2,
            skipped: 0,
            rowErrorCount: 1,
            rowErrors: [
              { row: 4, column: 'Redirect from', path: 'old page', message: 'is not a path' },
            ],
            userErrors: [],
          },
        };
      case 'PagesImportFromShopify':
        return {
          pagesImportFromShopify: {
            dryRun: variables.dryRun,
            pages: 3,
            created: 2,
            skipped: 1,
            pageErrors: [{ handle: 'untitled', message: 'Title is blank' }],
            userErrors: [],
          },
        };
      case 'CollectionsImportFromShopify':
        return {
          collectionsImportFromShopify: {
            dryRun: variables.dryRun,
            collections: 3,
            created: 2,
            skipped: 0,
            productsMissing: variables.dryRun ? 0 : 1,
            images: variables.dryRun ? 0 : 2,
            collectionErrors: [
              {
                handle: 'in-stock',
                message: "Hatti's smart collections have no rule on VARIANT_INVENTORY",
              },
            ],
            userErrors: [],
          },
        };
      case 'CustomersImportFromShopify':
        return {
          customersImportFromShopify: {
            dryRun: variables.dryRun,
            customers: 3,
            withoutPhone: 2,
            created: 2,
            skipped: 0,
            customerErrorCount: 1,
            customerErrors: [{ customer: 'Sara Ali', message: 'is not a Pakistani mobile number' }],
            addresses: variables.dryRun ? 0 : 3,
            addressErrors: variables.dryRun
              ? []
              : [
                  {
                    customer: 'Ayesha Khan',
                    message: "An address was not kept: City can't be blank",
                  },
                ],
            userErrors: [],
          },
        };
      case 'DiscountsImportFromShopify':
        return {
          discountsImportFromShopify: {
            dryRun: variables.dryRun,
            discounts: 4,
            created: 2,
            skipped: 1,
            expired: 1,
            discountErrors: [{ discount: 'By an app', message: 'An app made it' }],
            userErrors: [],
          },
        };
      case 'OrdersImportFromShopify':
        return {
          ordersImportFromShopify: {
            dryRun: variables.dryRun,
            orders: 40,
            created: variables.dryRun ? 40 : 38,
            skipped: variables.dryRun ? 0 : 2,
            linked: 30,
            userErrors: [],
          },
        };
      case 'BlogsImportFromShopify':
        return {
          blogsImportFromShopify: {
            dryRun: variables.dryRun,
            blogs: 2,
            blogsCreated: 1,
            articles: 6,
            created: 4,
            skipped: 1,
            images: variables.dryRun ? 0 : 3,
            articleErrors: [{ blog: 'news', article: 'old-post', message: 'Title is blank' }],
            userErrors: [],
          },
        };
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
      { csv: PRODUCTS, dryRun: true, overwrite: false, format: 'SHOPIFY' },
      { csv: PRODUCTS, dryRun: true, overwrite: true, format: 'SHOPIFY' },
      { csv: PRODUCTS, dryRun: false, overwrite: true, format: 'SHOPIFY' },
    ]);
  });

  it("checks the owner's Shopify store through its app, then imports it, keeping no credentials (ADR-749)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');

    fireEvent.click(await screen.findByRole('link', { name: 'Import and export' }));
    const check = await screen.findByRole('button', { name: 'Check the store' });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    type("Your store's address", 'zari.pk');
    type('Client ID', 'client-1');
    type('Client secret', 'secret-1');
    fireEvent.click(check);
    expect(
      await screen.findByText(/Give the store's address at Shopify, as zari\.myshopify\.com/),
    ).toBeTruthy();

    type("Your store's address", 'zari.myshopify.com');
    fireEvent.click(screen.getByRole('button', { name: 'Check the store' }));
    expect(
      await screen.findByText(
        'In your Shopify store: products to add: 4; to update: 0; to leave as they are: 0. Variants to make: 9.',
      ),
    ).toBeTruthy();
    // No file to look a row up in: the product is named by its handle, a redirect by its path.
    expect(screen.getByText('lawn-suit, Image Src: is not an https address')).toBeTruthy();
    expect(await screen.findByText('Redirects to add: 2; to leave as they are: 0.')).toBeTruthy();
    expect(screen.getByText('old page: is not a path')).toBeTruthy();
    expect(screen.getByText('Collections to add: 2; to leave as they are: 0.')).toBeTruthy();
    expect(
      screen.getByText("in-stock: Hatti's smart collections have no rule on VARIANT_INVENTORY"),
    ).toBeTruthy();
    expect(screen.getByText('Pages to add: 2; to leave as they are: 1.')).toBeTruthy();
    expect(screen.getByText('Past orders to keep: 40; kept already: 0.')).toBeTruthy();
    expect(screen.getByText('untitled: Title is blank')).toBeTruthy();
    expect(
      screen.getByText('Blogs to add: 1. Articles to add: 4; to leave as they are: 1.'),
    ).toBeTruthy();
    expect(screen.getByText('news/old-post: Title is blank')).toBeTruthy();
    expect(screen.getByText('Customers to add: 2; already here: 0.')).toBeTruthy();
    expect(
      screen.getByText('Discount codes to add: 2; already here: 1. Discounts that ended: 1.'),
    ).toBeTruthy();
    expect(screen.getByText('By an app: An app made it')).toBeTruthy();
    expect(screen.getByText('Customers with no phone number, left out: 2.')).toBeTruthy();
    expect(screen.getByText('Sara Ali: is not a Pakistani mobile number')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import them' }));
    expect(
      await screen.findByText(
        'Imported. Products added: 4; updated: 0; left as they were: 0. Images: 5. Variants given stock: 9.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Redirects added: 2; left as they were: 0.')).toBeTruthy();
    expect(
      screen.getByText('Collections added: 2, 2 with their images; left as they were: 0.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Products not in your shop, left out of their collections: 1.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'CollectionsImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(screen.getByText('Pages added: 2; left as they were: 1.')).toBeTruthy();
    // Its orders, as past orders, after its customers (ADR-786).
    expect(
      screen.getByText('Past orders kept: 38, 30 on their customers’ pages; kept already: 2.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'OrdersImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(
      screen.getByText(
        'Blogs added: 1. Articles added: 4, 3 with their images; left as they were: 1.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Customers added: 2; already here: 0. Addresses kept in their books: 3.'),
    ).toBeTruthy();
    expect(
      screen.getByText("Ayesha Khan: An address was not kept: City can't be blank"),
    ).toBeTruthy();
    expect(screen.getByText('Discount codes added: 2; already here: 1.')).toBeTruthy();
    expect(sentOf(fake, 'DiscountsImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(sentOf(fake, 'CustomersImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(sentOf(fake, 'BlogsImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(sentOf(fake, 'PagesImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect(sentOf(fake, 'UrlRedirectsImportFromShopify').map((sent) => sent.dryRun)).toEqual([
      true,
      false,
    ]);
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
    const sent = sentOf(fake, 'ProductsImportFromShopify');
    expect(sent.slice(1)).toEqual([
      {
        store: 'zari.myshopify.com',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        dryRun: true,
        overwrite: false,
      },
      {
        store: 'zari.myshopify.com',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        dryRun: false,
        overwrite: false,
      },
    ]);

    // Or a custom app's access token, the products alone.
    fireEvent.click(screen.getByLabelText(/Bring its URL redirects too/));
    fireEvent.click(screen.getByLabelText(/Bring its pages too/));
    fireEvent.click(screen.getByLabelText(/Bring its blogs too/));
    fireEvent.click(screen.getByLabelText(/Bring its collections too/));
    fireEvent.click(screen.getByLabelText(/Bring its customers too/));
    fireEvent.click(screen.getByLabelText(/Bring its discount codes too/));
    fireEvent.change(screen.getByLabelText('Your app'), { target: { value: 'TOKEN' } });
    type('Access token', 'shpat_1');
    fireEvent.click(screen.getByRole('button', { name: 'Check the store' }));
    await waitFor(() => expect(sentOf(fake, 'ProductsImportFromShopify')).toHaveLength(4));
    expect(sentOf(fake, 'ProductsImportFromShopify')[3]).toEqual({
      store: 'zari.myshopify.com',
      accessToken: 'shpat_1',
      dryRun: true,
      overwrite: false,
    });
    expect(sentOf(fake, 'UrlRedirectsImportFromShopify')).toHaveLength(2);
    expect(sentOf(fake, 'PagesImportFromShopify')).toHaveLength(2);
    expect(sentOf(fake, 'BlogsImportFromShopify')).toHaveLength(2);
    expect(sentOf(fake, 'CollectionsImportFromShopify')).toHaveLength(2);
    expect(sentOf(fake, 'CustomersImportFromShopify')).toHaveLength(2);
    expect(sentOf(fake, 'DiscountsImportFromShopify')).toHaveLength(2);
  });

  it("checks a WooCommerce export as WooCommerce's when told the file is from it (ADR-482)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');

    fireEvent.click(await screen.findByRole('link', { name: 'Import and export' }));
    await choose('Products file', 'wc-product-export.csv', PRODUCTS);
    await screen.findByText(/wc-product-export\.csv, rows: 6\./);
    fireEvent.change(screen.getByLabelText('The file is from'), {
      target: { value: 'WOOCOMMERCE' },
    });
    await waitFor(() => expect(sentOf(fake, 'ProductsImport')).toHaveLength(2));
    expect(sentOf(fake, 'ProductsImport')[1]).toEqual({
      csv: PRODUCTS,
      dryRun: true,
      overwrite: false,
      format: 'WOOCOMMERCE',
    });
  });

  it("checks a shop's Instagram posts as drafts, from JSON, when told the file is them (ONB-04)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products');

    fireEvent.click(await screen.findByRole('link', { name: 'Import and export' }));
    fireEvent.change(await screen.findByLabelText('The file is from'), {
      target: { value: 'INSTAGRAM' },
    });
    expect(screen.getByText(/posts_1\.json in Instagram's download/)).toBeTruthy();
    expect(screen.getByLabelText('Products file').getAttribute('accept')).toBe(
      '.json,application/json',
    );
    await choose('Products file', 'posts_1.json', '[]');
    await waitFor(() =>
      expect(sentOf(fake, 'ProductsImport')).toEqual([
        { csv: '[]', dryRun: true, overwrite: false, format: 'INSTAGRAM' },
      ]),
    );
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

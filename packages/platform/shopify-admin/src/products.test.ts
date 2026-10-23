import { describe, expect, it, vi } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreProducts, storeProductsCsv, storeProductsOf } from './products.js';

const SHOP = 'zari-kurtas.myshopify.com';

/** A kurta in two sizes with two photos and a video, and a mug without options, as JSON lines. */
const LINES = [
  {
    id: 'gid://shopify/Product/1',
    handle: 'cotton-kurta',
    title: 'Cotton "Eid" Kurta',
    descriptionHtml: '<p>Soft, cotton.</p>',
    vendor: 'Zari',
    productType: 'Kurtas',
    tags: ['Men', 'Eid'],
    status: 'ACTIVE',
    isGiftCard: false,
    seo: { title: 'Cotton kurta for Eid', description: null },
    category: { fullName: 'Apparel & Accessories > Clothing > Shirts & Tops' },
    options: [
      { name: 'Colour', position: 2 },
      { name: 'Size', position: 1 },
    ],
  },
  {
    id: 'gid://shopify/MediaImage/11',
    image: { url: 'https://cdn.shopify.com/kurta-white.jpg', altText: 'White kurta' },
    __parentId: 'gid://shopify/Product/1',
  },
  { __parentId: 'gid://shopify/Product/1' },
  {
    id: 'gid://shopify/MediaImage/12',
    image: { url: 'https://cdn.shopify.com/kurta-blue.jpg', altText: null },
    __parentId: 'gid://shopify/Product/1',
  },
  {
    id: 'gid://shopify/ProductVariant/101',
    sku: 'KUR-M',
    price: '2499.00',
    compareAtPrice: '2999.00',
    barcode: null,
    taxable: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 7,
    selectedOptions: [
      { name: 'Colour', value: 'White' },
      { name: 'Size', value: 'M' },
    ],
    image: { url: 'https://cdn.shopify.com/kurta-white.jpg' },
    inventoryItem: {
      tracked: true,
      unitCost: { amount: '1200.0' },
      measurement: { weight: { unit: 'KILOGRAMS', value: 0.3 } },
    },
    __parentId: 'gid://shopify/Product/1',
  },
  {
    id: 'gid://shopify/ProductVariant/102',
    sku: 'KUR-L',
    price: '2499.00',
    compareAtPrice: null,
    barcode: '8964000000017',
    taxable: false,
    inventoryPolicy: 'CONTINUE',
    inventoryQuantity: -2,
    selectedOptions: [
      { name: 'Size', value: 'L' },
      { name: 'Colour', value: 'Blue' },
    ],
    image: null,
    inventoryItem: { tracked: true, unitCost: null, measurement: { weight: null } },
    __parentId: 'gid://shopify/Product/1',
  },
  {
    id: 'gid://shopify/Product/2',
    handle: 'chai-mug',
    title: 'Chai Mug',
    descriptionHtml: '',
    vendor: 'Zari',
    productType: '',
    tags: [],
    status: 'DRAFT',
    isGiftCard: false,
    seo: { title: null, description: null },
    category: null,
    options: [{ name: 'Title', position: 1 }],
  },
  {
    id: 'gid://shopify/ProductVariant/201',
    sku: null,
    price: '1200.00',
    compareAtPrice: null,
    barcode: null,
    taxable: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 4,
    selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    image: null,
    inventoryItem: {
      tracked: false,
      unitCost: null,
      measurement: { weight: { unit: 'OUNCES', value: 12 } },
    },
    __parentId: 'gid://shopify/Product/2',
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

describe("A store's products as Shopify's product export (ADR-749)", () => {
  it('groups the bulk query’s lines into products, their images and variants', () => {
    const products = storeProductsOf(LINES);
    expect(products.map((product) => product.handle)).toEqual(['cotton-kurta', 'chai-mug']);
    expect(products[0]!.options.map((option) => option.name)).toEqual(['Size', 'Colour']);
    expect(products[0]!.images).toEqual([
      { url: 'https://cdn.shopify.com/kurta-white.jpg', altText: 'White kurta' },
      { url: 'https://cdn.shopify.com/kurta-blue.jpg', altText: null },
    ]);
    expect(products[0]!.variants.map((variant) => variant.sku)).toEqual(['KUR-M', 'KUR-L']);
  });

  it("writes Shopify's rows: product and first variant and image, then a row for each further one", () => {
    const { csv, rowHandles } = storeProductsCsv(storeProductsOf(LINES));
    const rows = csv
      .trimEnd()
      .split('\r\n')
      .map((line) =>
        line
          .slice(1, -1)
          .split('","')
          .map((cell) => cell.replace(/""/g, '"')),
      );
    const [headings, ...body] = rows;
    const cell = (row: number, heading: string) => body[row]![headings!.indexOf(heading)];
    expect(body).toHaveLength(3);
    expect(rowHandles).toEqual(['cotton-kurta', 'cotton-kurta', 'chai-mug']);

    expect(cell(0, 'Title')).toBe('Cotton "Eid" Kurta');
    expect(cell(0, 'Tags')).toBe('Men, Eid');
    expect(cell(0, 'Status')).toBe('active');
    expect(cell(0, 'Product Category')).toBe('Apparel & Accessories > Clothing > Shirts & Tops');
    // Options by Shopify's position, each variant's values in their order.
    expect([cell(0, 'Option1 Name'), cell(0, 'Option2 Name')]).toEqual(['Size', 'Colour']);
    expect([cell(0, 'Option1 Value'), cell(0, 'Option2 Value')]).toEqual(['M', 'White']);
    expect([cell(1, 'Option1 Value'), cell(1, 'Option2 Value')]).toEqual(['L', 'Blue']);
    expect(cell(1, 'Option1 Name')).toBe('');
    expect(cell(0, 'Variant Grams')).toBe('300');
    expect(cell(0, 'Variant Inventory Tracker')).toBe('shopify');
    expect(cell(0, 'Variant Inventory Qty')).toBe('7');
    expect(cell(1, 'Variant Inventory Qty')).toBe('-2');
    expect(cell(1, 'Variant Inventory Policy')).toBe('continue');
    expect(cell(0, 'Variant Compare At Price')).toBe('2999.00');
    expect(cell(1, 'Variant Taxable')).toBe('FALSE');
    expect(cell(0, 'Cost per item')).toBe('1200.0');
    expect(cell(0, 'Variant Image')).toBe('https://cdn.shopify.com/kurta-white.jpg');
    expect([cell(1, 'Image Src'), cell(1, 'Image Position')]).toEqual([
      'https://cdn.shopify.com/kurta-blue.jpg',
      '2',
    ]);
    // A product without options, as Shopify writes it; stock it did not track is left blank.
    expect([cell(2, 'Option1 Name'), cell(2, 'Option1 Value')]).toEqual(['Title', 'Default Title']);
    expect(cell(2, 'Variant Inventory Qty')).toBe('');
    expect(cell(2, 'Variant Grams')).toBe('340');
    expect(cell(2, 'Status')).toBe('draft');
  });

  it('asks the store, then runs the bulk query, waits for its file, and reads it', async () => {
    const asked: string[] = [];
    let polls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://storage.googleapis.com/')) return new Response(LINES);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      asked.push(query.trim().split(/\s/)[0]!);
      const data = query.includes('shop {')
        ? { shop: { name: 'Zari Kurtas', currencyCode: 'PKR' } }
        : query.includes('bulkOperationRunQuery')
          ? {
              bulkOperationRunQuery: {
                bulkOperation: { id: 'gid://shopify/BulkOperation/9', status: 'CREATED' },
                userErrors: [],
              },
            }
          : {
              node:
                ++polls < 2
                  ? { id: 'gid://shopify/BulkOperation/9', status: 'RUNNING' }
                  : {
                      id: 'gid://shopify/BulkOperation/9',
                      status: 'COMPLETED',
                      url: 'https://storage.googleapis.com/shopify/bulk.jsonl',
                    },
            };
      return new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const admin = new ShopifyAdmin({
      shop: SHOP,
      credentials: { accessToken: 't' },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const sleep = vi.fn(async () => {});
    const read = await readStoreProducts(admin, { sleep });
    expect(read).toMatchObject({
      ok: true,
      value: { storeName: 'Zari Kurtas', currency: 'PKR', products: 2 },
    });
    expect(asked).toEqual(['{', 'mutation', 'query', 'query']);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('cancels an export that takes longer than it waits, and says why one failed', async () => {
    const queries: string[] = [];
    const answer = (status: string, errorCode?: string) =>
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        queries.push(query);
        const data = query.includes('shop {')
          ? { shop: { name: 'Zari', currencyCode: 'PKR' } }
          : query.includes('bulkOperationRunQuery')
            ? {
                bulkOperationRunQuery: {
                  bulkOperation: { id: 'b', status: 'CREATED' },
                  userErrors: [],
                },
              }
            : query.includes('bulkOperationCancel')
              ? { bulkOperationCancel: { userErrors: [] } }
              : { node: { id: 'b', status, errorCode } };
        return new Response(JSON.stringify({ data }));
      });
    const read = (fetch: ReturnType<typeof answer>) =>
      readStoreProducts(
        new ShopifyAdmin({
          shop: SHOP,
          credentials: { accessToken: 't' },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
        { waitMs: 4_000, pollMs: 2_000, sleep: async () => {} },
      );
    expect(await read(answer('RUNNING'))).toMatchObject({ ok: false, kind: 'busy' });
    expect(queries.filter((query) => query.includes('bulkOperationCancel'))).toHaveLength(1);
    expect(await read(answer('FAILED', 'ACCESS_DENIED'))).toMatchObject({
      ok: false,
      kind: 'scope',
    });
    expect(await read(answer('COMPLETED'))).toMatchObject({ ok: true, value: { products: 0 } });
  });
});

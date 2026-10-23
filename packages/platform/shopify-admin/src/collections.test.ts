import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreCollections } from './collections.js';

const LINES = [
  {
    id: 'gid://shopify/Collection/1',
    handle: 'eid-edit',
    title: 'Eid edit',
    descriptionHtml: '<p>Picked for Eid.</p>',
    sortOrder: 'MANUAL',
    templateSuffix: '',
    seo: { title: 'Eid edit 2026', description: null },
    image: { url: 'https://cdn.shopify.com/s/files/1/eid.jpg', altText: 'Eid edit' },
    ruleSet: null,
  },
  { id: 'gid://shopify/Product/12', handle: 'lawn-suit', __parentId: 'gid://shopify/Collection/1' },
  {
    id: 'gid://shopify/Product/11',
    handle: 'silk-dupatta',
    __parentId: 'gid://shopify/Collection/1',
  },
  {
    id: 'gid://shopify/Collection/2',
    handle: 'under-5000',
    title: 'Under Rs 5,000',
    descriptionHtml: '',
    sortOrder: 'PRICE_ASC',
    templateSuffix: null,
    seo: { title: null, description: null },
    ruleSet: {
      appliedDisjunctively: false,
      rules: [
        { column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '5000.00' },
        { column: 'TAG', relation: 'EQUALS', condition: 'lawn' },
      ],
    },
  },
  { id: 'gid://shopify/Product/12', handle: 'lawn-suit', __parentId: 'gid://shopify/Collection/2' },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const store = (url: string | null = 'https://storage.googleapis.com/c') =>
  new ShopifyAdmin({
    shop: 'zari-kurtas.myshopify.com',
    credentials: { accessToken: 't' },
    fetch: (async (address: string, init?: RequestInit) => {
      if (address.startsWith('https://storage.googleapis.com/')) return new Response(LINES);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const data = query.includes('shop {')
        ? { shop: { name: 'Zari Kurtas', currencyCode: 'PKR', weightUnit: 'KILOGRAMS' } }
        : query.includes('bulkOperationRunQuery')
          ? {
              bulkOperationRunQuery: {
                bulkOperation: { id: 'b', status: 'CREATED' },
                userErrors: [],
              },
            }
          : { node: { id: 'b', status: 'COMPLETED', url } };
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch,
  });

describe("A store's collections through its Admin API (ADR-754)", () => {
  it('reads each collection with its rules, or its products in its own order', async () => {
    const read = await readStoreCollections(store(), { sleep: async () => {} });
    expect(read).toMatchObject({
      ok: true,
      value: { storeName: 'Zari Kurtas', currency: 'PKR', weightUnit: 'KILOGRAMS' },
    });
    const collections = read.ok ? read.value.collections : [];
    expect(collections[0]).toEqual({
      handle: 'eid-edit',
      title: 'Eid edit',
      descriptionHtml: '<p>Picked for Eid.</p>',
      sortOrder: 'MANUAL',
      templateSuffix: null,
      seo: { title: 'Eid edit 2026', description: null },
      // Its image, to bring (ADR-785).
      image: { url: 'https://cdn.shopify.com/s/files/1/eid.jpg', altText: 'Eid edit' },
      ruleSet: null,
      products: ['lawn-suit', 'silk-dupatta'],
    });
    expect(collections[1]).toMatchObject({
      image: null,
      handle: 'under-5000',
      sortOrder: 'PRICE_ASC',
      ruleSet: {
        appliedDisjunctively: false,
        rules: [
          { column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '5000.00' },
          { column: 'TAG', relation: 'EQUALS', condition: 'lawn' },
        ],
      },
      products: ['lawn-suit'],
    });
  });

  it('reads no collections where Shopify wrote no file, the store having none', async () => {
    const read = await readStoreCollections(store(null), { sleep: async () => {} });
    expect(read).toMatchObject({ ok: true, value: { collections: [] } });
  });
});

import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreMetafields } from './metafields.js';

const lines = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');

/** Each kind's export, by the file the bulk query names. */
const FILES: Record<string, string> = {
  products: lines([
    { id: 'gid://shopify/Product/1', handle: 'lawn-suit' },
    {
      id: 'gid://shopify/Metafield/11',
      namespace: 'custom',
      key: 'fabric',
      type: 'single_line_text_field',
      value: 'Lawn',
      __parentId: 'gid://shopify/Product/1',
    },
    // A product with none is left out.
    { id: 'gid://shopify/Product/2', handle: 'plain' },
  ]),
  variants: lines([
    { id: 'gid://shopify/ProductVariant/5', title: 'M / Maroon', product: { handle: 'lawn-suit' } },
    {
      id: 'gid://shopify/Metafield/51',
      namespace: 'custom',
      key: 'length',
      type: 'number_integer',
      value: '42',
      __parentId: 'gid://shopify/ProductVariant/5',
    },
  ]),
  collections: lines([
    { id: 'gid://shopify/Collection/9', handle: 'eid' },
    {
      id: 'gid://shopify/Metafield/91',
      namespace: 'custom',
      key: 'banner',
      type: 'file_reference',
      value: 'gid://shopify/MediaImage/1',
      __parentId: 'gid://shopify/Collection/9',
    },
  ]),
};

const store = (failed?: string) => {
  let running = '';
  return new ShopifyAdmin({
    shop: 'zari-kurtas.myshopify.com',
    credentials: { accessToken: 't' },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://storage.googleapis.com/')) {
        return new Response(FILES[url.split('/').at(-1)!]);
      }
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      if (query.includes('bulkOperationRunQuery')) {
        const asked = JSON.stringify(variables ?? {}) + query;
        running = /productVariants/.test(asked)
          ? 'variants'
          : /collections/.test(asked)
            ? 'collections'
            : 'products';
      }
      const data = query.includes('shop {')
        ? { shop: { name: 'Zari Kurtas' } }
        : query.includes('bulkOperationRunQuery')
          ? {
              bulkOperationRunQuery: {
                bulkOperation: { id: 'b', status: 'CREATED' },
                userErrors: [],
              },
            }
          : failed
            ? { node: { id: 'b', status: 'FAILED', errorCode: failed } }
            : {
                node: {
                  id: 'b',
                  status: 'COMPLETED',
                  url: `https://storage.googleapis.com/${running}`,
                },
              };
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch,
  });
};

describe("A store's metafields through its Admin API (ADR-789)", () => {
  it("reads products', variants' and collections' metafields, each owner by what names it", async () => {
    expect(await readStoreMetafields(store(), { sleep: async () => {} })).toEqual({
      ok: true,
      value: {
        storeName: 'Zari Kurtas',
        owners: [
          {
            owner: { type: 'product', handle: 'lawn-suit' },
            metafields: [
              { namespace: 'custom', key: 'fabric', type: 'single_line_text_field', value: 'Lawn' },
            ],
          },
          {
            owner: { type: 'variant', handle: 'lawn-suit', title: 'M / Maroon' },
            metafields: [
              { namespace: 'custom', key: 'length', type: 'number_integer', value: '42' },
            ],
          },
          {
            owner: { type: 'collection', handle: 'eid' },
            metafields: [
              {
                namespace: 'custom',
                key: 'banner',
                type: 'file_reference',
                value: 'gid://shopify/MediaImage/1',
              },
            ],
          },
        ],
      },
    });
  });

  it('says why Shopify refused', async () => {
    expect(
      await readStoreMetafields(store('ACCESS_DENIED'), { sleep: async () => {} }),
    ).toMatchObject({ ok: false, kind: 'scope' });
  });
});

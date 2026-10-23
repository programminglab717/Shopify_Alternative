import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreRedirects, storeRedirectsCsv } from './redirects.js';

describe("A store's URL redirects as Shopify's redirects export (ADR-751)", () => {
  it('writes each redirect on a row of its own, its path and target quoted', () => {
    expect(
      storeRedirectsCsv([
        { path: '/products/old-kurta', target: '/products/cotton-kurta' },
        { path: '/eid', target: 'https://zari.pk/collections/eid?sort="new"' },
      ]),
    ).toEqual({
      csv:
        '"Redirect from","Redirect to"\r\n' +
        '"/products/old-kurta","/products/cotton-kurta"\r\n' +
        '"/eid","https://zari.pk/collections/eid?sort=""new"""\r\n',
      rowPaths: ['/products/old-kurta', '/eid'],
    });
  });

  it('reads them in a bulk query, and says the scope it needs when Shopify refuses', async () => {
    const store = (failed?: string) =>
      new ShopifyAdmin({
        shop: 'zari-kurtas.myshopify.com',
        credentials: { accessToken: 't' },
        fetch: (async (url: string, init?: RequestInit) => {
          if (url.startsWith('https://storage.googleapis.com/')) {
            return new Response('{"id":"gid://shopify/UrlRedirect/1","path":"/a","target":"/b"}\n');
          }
          const { query } = JSON.parse(String(init?.body)) as { query: string };
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
                    node: { id: 'b', status: 'COMPLETED', url: 'https://storage.googleapis.com/r' },
                  };
          return new Response(JSON.stringify({ data }));
        }) as typeof fetch,
      });
    expect(await readStoreRedirects(store(), { sleep: async () => {} })).toEqual({
      ok: true,
      value: {
        storeName: 'Zari Kurtas',
        redirects: 1,
        csv: '"Redirect from","Redirect to"\r\n"/a","/b"\r\n',
        rowPaths: ['/a'],
      },
    });
    expect(await readStoreRedirects(store('ACCESS_DENIED'), { sleep: async () => {} })).toEqual({
      ok: false,
      kind: 'scope',
      message:
        "The store's app may not read its redirects: give it the read_online_store_navigation " +
        'access scope',
    });
  });
});

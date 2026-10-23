import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStorePages } from './pages.js';

const LINES = [
  {
    id: 'gid://shopify/Page/1',
    handle: 'about-us',
    title: 'About us',
    body: '<p>Since 1998.</p>',
    isPublished: true,
    publishedAt: '2024-03-01T10:00:00Z',
    templateSuffix: '',
  },
  {
    id: 'gid://shopify/Page/2',
    handle: 'contact',
    title: 'Contact',
    body: '',
    isPublished: false,
    publishedAt: null,
    templateSuffix: 'contact',
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const store = (failed?: string) =>
  new ShopifyAdmin({
    shop: 'zari-kurtas.myshopify.com',
    credentials: { accessToken: 't' },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://storage.googleapis.com/')) return new Response(LINES);
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
            : { node: { id: 'b', status: 'COMPLETED', url: 'https://storage.googleapis.com/p' } };
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch,
  });

describe("A store's own pages through its Admin API (ADR-752)", () => {
  it('reads each page, its body, whether and since when it is shown, and its template', async () => {
    expect(await readStorePages(store(), { sleep: async () => {} })).toEqual({
      ok: true,
      value: {
        storeName: 'Zari Kurtas',
        pages: [
          {
            handle: 'about-us',
            title: 'About us',
            body: '<p>Since 1998.</p>',
            isPublished: true,
            publishedAt: '2024-03-01T10:00:00Z',
            templateSuffix: null,
          },
          {
            handle: 'contact',
            title: 'Contact',
            body: '',
            isPublished: false,
            publishedAt: null,
            templateSuffix: 'contact',
          },
        ],
      },
    });
  });

  it('says the scope the app needs when Shopify refuses', async () => {
    expect(await readStorePages(store('ACCESS_DENIED'), { sleep: async () => {} })).toEqual({
      ok: false,
      kind: 'scope',
      message:
        "The store's app may not read its pages: give it the read_online_store_pages access scope",
    });
  });
});

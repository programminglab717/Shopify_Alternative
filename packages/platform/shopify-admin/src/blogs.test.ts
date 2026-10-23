import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreBlogs } from './blogs.js';

const LINES = [
  {
    id: 'gid://shopify/Blog/1',
    handle: 'news',
    title: 'News',
    commentPolicy: 'MODERATED',
    templateSuffix: '',
  },
  {
    id: 'gid://shopify/Article/11',
    handle: 'eid-collection',
    title: 'Our Eid collection',
    body: '<p>Lawn for Eid.</p>',
    summary: '<p>Lawn.</p>',
    tags: ['eid', 'lawn'],
    isPublished: true,
    publishedAt: '2025-03-20T09:00:00Z',
    templateSuffix: null,
    author: { name: 'Ayesha' },
    __parentId: 'gid://shopify/Blog/1',
  },
  {
    id: 'gid://shopify/Article/12',
    handle: 'draft-post',
    title: 'Draft',
    body: '',
    summary: null,
    tags: [],
    isPublished: false,
    publishedAt: null,
    templateSuffix: null,
    author: null,
    __parentId: 'gid://shopify/Blog/1',
  },
  { id: 'gid://shopify/Blog/2', handle: 'recipes', title: 'Recipes', commentPolicy: 'CLOSED' },
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
            : { node: { id: 'b', status: 'COMPLETED', url: 'https://storage.googleapis.com/b' } };
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch,
  });

describe("A store's blogs and their articles through its Admin API (ADR-753)", () => {
  it('reads each blog with its articles, their bodies, authors, tags and when they were shown', async () => {
    const read = await readStoreBlogs(store(), { sleep: async () => {} });
    expect(read).toMatchObject({ ok: true, value: { storeName: 'Zari Kurtas' } });
    const blogs = read.ok ? read.value.blogs : [];
    expect(blogs.map((blog) => [blog.handle, blog.commentPolicy, blog.articles.length])).toEqual([
      ['news', 'MODERATED', 2],
      ['recipes', 'CLOSED', 0],
    ]);
    expect(blogs[0]!.articles[0]).toEqual({
      handle: 'eid-collection',
      title: 'Our Eid collection',
      body: '<p>Lawn for Eid.</p>',
      summary: '<p>Lawn.</p>',
      author: 'Ayesha',
      tags: ['eid', 'lawn'],
      isPublished: true,
      publishedAt: '2025-03-20T09:00:00Z',
      templateSuffix: null,
    });
    expect(blogs[0]!.articles[1]).toMatchObject({
      author: null,
      summary: null,
      isPublished: false,
    });
  });

  it('says the scope the app needs when Shopify refuses', async () => {
    expect(await readStoreBlogs(store('ACCESS_DENIED'), { sleep: async () => {} })).toEqual({
      ok: false,
      kind: 'scope',
      message: "The store's app may not read its blogs: give it the read_content access scope",
    });
  });
});

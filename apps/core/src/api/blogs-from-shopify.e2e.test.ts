import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { ShopifyStores } from './shopify-stores.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IMPORT = `mutation ($store: String!, $accessToken: String, $dryRun: Boolean) {
  blogsImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    blogs blogsCreated articles created skipped dryRun
    articleErrors { blog article message }
    userErrors { field code message }
  }
}`;

/** A blog of two articles and one of none, as Shopify's bulk query writes them. */
const LINES = [
  { id: 'gid://shopify/Blog/1', handle: 'news', title: 'News', commentPolicy: 'MODERATED' },
  {
    id: 'gid://shopify/Article/11',
    handle: 'eid-collection',
    title: 'Our Eid collection',
    body: '<p>Lawn for Eid.</p><script>x()</script>',
    summary: null,
    tags: ['eid'],
    isPublished: true,
    publishedAt: '2025-03-20T09:00:00Z',
    author: { name: 'Ayesha' },
    __parentId: 'gid://shopify/Blog/1',
  },
  {
    id: 'gid://shopify/Article/12',
    handle: 'winter-plans',
    title: 'Winter plans',
    body: '',
    summary: null,
    tags: [],
    isPublished: false,
    publishedAt: null,
    author: null,
    __parentId: 'gid://shopify/Blog/1',
  },
  { id: 'gid://shopify/Blog/2', handle: 'recipes', title: 'Recipes', commentPolicy: 'CLOSED' },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const shopify = new ShopifyStores(
  async (input, init) => {
    if (String(input).startsWith('https://storage.googleapis.com/')) return new Response(LINES);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas' } }
      : query.includes('bulkOperationRunQuery')
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/4', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/4',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/blogs.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: blogs from a Shopify store's Admin API", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const { token: issued, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, ['write_content', 'read_content']],
    );
    token = issued;
    api = await startTestApi(testDb, { shopifyStores: shopify });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("counts the store's blogs and articles, then makes them at their handles, shown as they were (ADR-753)", async () => {
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.blogsImportFromShopify,
    ).toEqual({
      blogs: 2,
      blogsCreated: 2,
      articles: 2,
      created: 2,
      skipped: 0,
      dryRun: true,
      articleErrors: [],
      userErrors: [],
    });
    expect((await gql(IMPORT, variables)).data?.blogsImportFromShopify).toMatchObject({
      blogsCreated: 2,
      created: 2,
      skipped: 0,
      articleErrors: [],
    });
    const { data } = await gql(`{
      blogs(first: 10) { nodes { handle title commentPolicy } }
      articles(first: 10) { nodes { handle title body author { name } tags isPublished publishedAt blog { handle } } }
    }`);
    expect(data?.blogs.nodes).toEqual([
      { handle: 'news', title: 'News', commentPolicy: 'MODERATED' },
      { handle: 'recipes', title: 'Recipes', commentPolicy: 'CLOSED' },
    ]);
    expect(data?.articles.nodes).toEqual(
      expect.arrayContaining([
        {
          handle: 'eid-collection',
          title: 'Our Eid collection',
          body: '<p>Lawn for Eid.</p>',
          author: { name: 'Ayesha' },
          tags: ['eid'],
          isPublished: true,
          publishedAt: '2025-03-20T09:00:00.000Z',
          blog: { handle: 'news' },
        },
        expect.objectContaining({ handle: 'winter-plans', isPublished: false, publishedAt: null }),
      ]),
    );

    // Again: the blogs and their articles are there, and left as they are.
    expect((await gql(IMPORT, variables)).data?.blogsImportFromShopify).toMatchObject({
      blogsCreated: 0,
      created: 0,
      skipped: 2,
    });
  });
});

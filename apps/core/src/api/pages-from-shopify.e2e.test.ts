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
  pagesImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    pages created skipped dryRun
    pageErrors { handle message }
    userErrors { field code message }
  }
}`;

/** The store's pages, as Shopify's bulk query writes them. */
const LINES = [
  {
    id: 'gid://shopify/Page/1',
    handle: 'about-us',
    title: 'About us',
    body: '<p>Since 1998.</p><script>alert(1)</script>',
    isPublished: true,
    publishedAt: '2024-03-01T10:00:00Z',
    templateSuffix: '',
  },
  {
    id: 'gid://shopify/Page/2',
    handle: 'sale-rules',
    title: 'Sale rules',
    body: '<p>Soon.</p>',
    isPublished: false,
    publishedAt: null,
    templateSuffix: null,
  },
  {
    id: 'gid://shopify/Page/3',
    handle: 'untitled',
    title: '',
    body: '',
    isPublished: true,
    publishedAt: '2024-03-01T10:00:00Z',
    templateSuffix: null,
  },
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
              bulkOperation: { id: 'gid://shopify/BulkOperation/3', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/3',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/pages.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: pages from a Shopify store's Admin API", () => {
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
      [shop, hash, hint, ['write_online_store_pages', 'read_online_store_pages']],
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

  it("counts the store's pages, then makes them at their handles, cleaned, shown as they were (ADR-752)", async () => {
    const variables = { store: 'zari-kurtas.myshopify.com', accessToken: 'shpat_1' };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.pagesImportFromShopify,
    ).toEqual({
      pages: 3,
      created: 3,
      skipped: 0,
      dryRun: true,
      pageErrors: [],
      userErrors: [],
    });
    const done = (await gql(IMPORT, variables)).data?.pagesImportFromShopify;
    expect(done).toMatchObject({ pages: 3, created: 2, skipped: 0, dryRun: false });
    expect(done.pageErrors).toMatchObject([{ handle: 'untitled' }]);

    const { data } = await gql(
      '{ pages(first: 10) { nodes { handle title body isPublished publishedAt } } }',
    );
    expect(data?.pages.nodes).toEqual([
      {
        handle: 'about-us',
        title: 'About us',
        body: '<p>Since 1998.</p>',
        isPublished: true,
        publishedAt: '2024-03-01T10:00:00.000Z',
      },
      {
        handle: 'sale-rules',
        title: 'Sale rules',
        body: '<p>Soon.</p>',
        isPublished: false,
        publishedAt: null,
      },
    ]);

    // Again: the shop has them now, and leaves them as they are.
    expect((await gql(IMPORT, variables)).data?.pagesImportFromShopify).toMatchObject({
      created: 0,
      skipped: 2,
    });
  });
});

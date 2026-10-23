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
  urlRedirectsImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    rows created skipped rowErrorCount dryRun
    rowErrors { row column path message }
    userErrors { field code message }
  }
}`;

/** The store's redirects, as Shopify's bulk query writes them, and whether it refuses. */
const store = {
  lines: [
    { id: 'gid://shopify/UrlRedirect/1', path: '/products/old-kurta', target: '/products/kurta' },
    { id: 'gid://shopify/UrlRedirect/2', path: '/eid', target: '/collections/eid' },
    { id: 'gid://shopify/UrlRedirect/3', path: 'not a path', target: '/collections/eid' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n'),
  denied: false,
};

const shopify = new ShopifyStores(
  async (input, init) => {
    if (String(input).startsWith('https://storage.googleapis.com/')) {
      return new Response(store.lines);
    }
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas' } }
      : query.includes('bulkOperationRunQuery')
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/2', status: 'CREATED' },
              userErrors: [],
            },
          }
        : store.denied
          ? { node: { id: 'b', status: 'FAILED', errorCode: 'ACCESS_DENIED' } }
          : {
              node: {
                id: 'gid://shopify/BulkOperation/2',
                status: 'COMPLETED',
                url: 'https://storage.googleapis.com/shopify/redirects.jsonl',
              },
            };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: redirects from a Shopify store's Admin API", () => {
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
      [shop, hash, hint, ['write_online_store_navigation', 'read_online_store_navigation']],
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

  it("counts the store's redirects in a dry run, then makes them, each problem by its path (ADR-751)", async () => {
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    const dry = await gql(IMPORT, { ...variables, dryRun: true });
    expect(dry.data?.urlRedirectsImportFromShopify).toMatchObject({
      rows: 3,
      created: 2,
      dryRun: true,
      rowErrorCount: 1,
      userErrors: [],
    });
    const done = await gql(IMPORT, variables);
    const payload = done.data?.urlRedirectsImportFromShopify;
    expect(payload).toMatchObject({ rows: 3, created: 2, skipped: 0, dryRun: false });
    expect(payload.rowErrors).toMatchObject([{ row: 4, path: 'not a path' }]);
    const { data } = await gql('{ urlRedirects(first: 10) { nodes { path target } } }');
    expect(data?.urlRedirects.nodes).toEqual([
      { path: '/products/old-kurta', target: '/products/kurta' },
      { path: '/eid', target: '/collections/eid' },
    ]);

    // Again: the shop has them, and leaves them as they are.
    expect((await gql(IMPORT, variables)).data?.urlRedirectsImportFromShopify).toMatchObject({
      created: 0,
      skipped: 2,
    });
  });

  it('says the scope the app needs, and that a store has none', async () => {
    const errors = async () =>
      (await gql(IMPORT, { store: 'zari-kurtas', accessToken: 'shpat_1' })).data
        ?.urlRedirectsImportFromShopify.userErrors;
    store.denied = true;
    expect(await errors()).toEqual([
      {
        field: ['accessToken'],
        code: 'INVALID',
        message:
          "The store's app may not read its redirects: give it the " +
          'read_online_store_navigation access scope',
      },
    ]);
    store.denied = false;
    store.lines = '';
    expect(await errors()).toEqual([
      { field: ['store'], code: 'BLANK', message: 'Zari Kurtas has no redirects' },
    ]);
  });
});

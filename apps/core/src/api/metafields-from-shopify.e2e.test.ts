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
  metafieldsImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    metafields set unsupported missing dryRun
    metafieldErrors { owner metafield message }
    userErrors { field code message }
  }
}`;

const lines = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const field = (
  id: number,
  parent: string,
  namespace: string,
  key: string,
  type: string,
  value: string,
) => ({
  id: `gid://shopify/Metafield/${id}`,
  namespace,
  key,
  type,
  value,
  __parentId: parent,
});

/** Each kind's export, by the file its bulk query names. */
const FILES: Record<string, string> = {
  products: lines([
    { id: 'gid://shopify/Product/1', handle: 'lawn-suit' },
    field(11, 'gid://shopify/Product/1', 'custom', 'fabric', 'single_line_text_field', 'Lawn'),
    field(12, 'gid://shopify/Product/1', 'custom', 'pieces', 'number_integer', 'three'),
    field(
      13,
      'gid://shopify/Product/1',
      'custom',
      'swatch',
      'file_reference',
      'gid://shopify/MediaImage/1',
    ),
    field(14, 'gid://shopify/Product/1', '$app:reviews', 'rating', 'single_line_text_field', '4'),
    { id: 'gid://shopify/Product/2', handle: 'gone' },
    field(21, 'gid://shopify/Product/2', 'custom', 'fabric', 'single_line_text_field', 'Silk'),
  ]),
  variants: lines([
    { id: 'gid://shopify/ProductVariant/5', title: 'M', product: { handle: 'lawn-suit' } },
    field(51, 'gid://shopify/ProductVariant/5', 'custom', 'length', 'number_integer', '42'),
  ]),
  collections: lines([
    { id: 'gid://shopify/Collection/9', handle: 'eid' },
    field(91, 'gid://shopify/Collection/9', 'custom', 'season', 'single_line_text_field', 'Eid'),
  ]),
};

let running = '';
const shopify = new ShopifyStores(
  async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://storage.googleapis.com/')) {
      return new Response(FILES[url.split('/').at(-1)!]);
    }
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    if (query.includes('bulkOperationRunQuery')) {
      const asked = JSON.stringify(variables ?? {});
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
              bulkOperation: { id: 'gid://shopify/BulkOperation/9', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/9',
              status: 'COMPLETED',
              url: `https://storage.googleapis.com/${running}`,
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: metafields from a Shopify store's Admin API", () => {
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
      [shop, hash, hint, ['write_products', 'read_products']],
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

  it("sets the store's metafields on the shop's products, variants and collections of the same handles (ADR-789)", async () => {
    const made = await gql(
      `mutation {
        productCreate(input: { title: "Lawn suit", status: ACTIVE, options: [{ name: "Size", values: ["M", "L"] }] }) {
          product { id handle } userErrors { message }
        }
        collectionCreate(input: { title: "Eid" }) { collection { id } userErrors { message } }
      }`,
    );
    expect(made.data?.productCreate.userErrors).toEqual([]);
    const productId = made.data?.productCreate.product.id as string;
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.metafieldsImportFromShopify,
    ).toEqual({
      metafields: 7,
      set: 4,
      unsupported: 2,
      missing: 1,
      dryRun: true,
      metafieldErrors: [],
      userErrors: [],
    });
    // A value not of its type is named; the rest are set.
    expect((await gql(IMPORT, variables)).data?.metafieldsImportFromShopify).toMatchObject({
      set: 3,
      unsupported: 2,
      missing: 1,
      metafieldErrors: [
        { owner: 'lawn-suit', metafield: 'custom.pieces', message: expect.any(String) },
      ],
    });
    const read = await gql(
      `query ($id: ID!) {
        product(id: $id) {
          metafields { namespace key type value }
          variants { title metafield(namespace: "custom", key: "length") { value } }
        }
        collectionByHandle(handle: "eid") { metafield(namespace: "custom", key: "season") { value } }
      }`,
      { id: productId },
    );
    const { data } = read;
    expect(read.errors).toBeUndefined();
    expect(data?.product.metafields).toEqual([
      { namespace: 'custom', key: 'fabric', type: 'single_line_text_field', value: 'Lawn' },
    ]);
    expect(data?.product.variants).toEqual([
      { title: 'M', metafield: { value: '42' } },
      { title: 'L', metafield: null },
    ]);
    expect(data?.collectionByHandle.metafield).toEqual({ value: 'Eid' });
  });
});

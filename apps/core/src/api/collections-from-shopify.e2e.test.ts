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
  collectionsImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    collections created skipped productsMissing dryRun
    collectionErrors { handle message }
    userErrors { field code message }
  }
}`;

/**
 * A hand-picked collection of two of the shop's products and one it has not, a smart one by price
 * and tag, one by weight in kilograms, and one by stock, which the catalog has no rule on.
 */
const LINES = [
  {
    id: 'gid://shopify/Collection/1',
    handle: 'eid-edit',
    title: 'Eid edit',
    descriptionHtml: '<p>Picked for Eid.</p>',
    sortOrder: 'BEST_SELLING',
    seo: { title: 'Eid edit 2026', description: null },
    ruleSet: null,
  },
  {
    id: 'gid://shopify/Product/2',
    handle: 'silk-dupatta',
    __parentId: 'gid://shopify/Collection/1',
  },
  { id: 'gid://shopify/Product/3', handle: 'sold-shawl', __parentId: 'gid://shopify/Collection/1' },
  { id: 'gid://shopify/Product/1', handle: 'lawn-suit', __parentId: 'gid://shopify/Collection/1' },
  {
    id: 'gid://shopify/Collection/2',
    handle: 'lawn-under-5000',
    title: 'Lawn under Rs 5,000',
    descriptionHtml: '',
    sortOrder: 'PRICE_ASC',
    seo: { title: null, description: null },
    ruleSet: {
      appliedDisjunctively: false,
      rules: [
        { column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '5000.00' },
        { column: 'TAG', relation: 'EQUALS', condition: 'lawn' },
      ],
    },
  },
  { id: 'gid://shopify/Product/1', handle: 'lawn-suit', __parentId: 'gid://shopify/Collection/2' },
  {
    id: 'gid://shopify/Collection/3',
    handle: 'heavy',
    title: 'Heavy',
    descriptionHtml: '',
    sortOrder: 'MANUAL',
    seo: { title: null, description: null },
    ruleSet: {
      appliedDisjunctively: true,
      rules: [{ column: 'VARIANT_WEIGHT', relation: 'GREATER_THAN', condition: '1.5' }],
    },
  },
  {
    id: 'gid://shopify/Collection/4',
    handle: 'in-stock',
    title: 'In stock',
    descriptionHtml: '',
    sortOrder: 'CREATED_DESC',
    seo: { title: null, description: null },
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }],
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const shopify = new ShopifyStores(
  async (input, init) => {
    if (String(input).startsWith('https://storage.googleapis.com/')) return new Response(LINES);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas', currencyCode: 'PKR', weightUnit: 'KILOGRAMS' } }
      : query.includes('bulkOperationRunQuery')
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/5', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/5',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/collections.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: collections from a Shopify store's Admin API", () => {
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

  it("counts the store's collections, then makes them with their rules or products in the store's order (ADR-754)", async () => {
    for (const [title, price, tags] of [
      ['Lawn suit', '4,500', ['lawn']],
      ['Silk dupatta', '6,000', ['silk']],
    ] as const) {
      const { data } = await gql(
        `mutation ($input: ProductCreateInput!) {
           productCreate(input: $input) { userErrors { message } }
         }`,
        { input: { title, status: 'ACTIVE', tags, variants: [{ price }] } },
      );
      expect(data?.productCreate.userErrors).toEqual([]);
    }
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    const refusal = {
      handle: 'in-stock',
      message: "Hatti's smart collections have no rule on VARIANT_INVENTORY",
    };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.collectionsImportFromShopify,
    ).toEqual({
      collections: 4,
      created: 3,
      skipped: 0,
      productsMissing: 0,
      dryRun: true,
      collectionErrors: [refusal],
      userErrors: [],
    });
    expect((await gql(IMPORT, variables)).data?.collectionsImportFromShopify).toMatchObject({
      created: 3,
      skipped: 0,
      productsMissing: 1,
      collectionErrors: [refusal],
    });

    const fields = `title description sortOrder seo { title }
      ruleSet { appliedDisjunctively rules { column relation condition } }
      products(first: 10) { nodes { handle } }`;
    const { data } = await gql(`{
      eid: collectionByHandle(handle: "eid-edit") { ${fields} }
      lawn: collectionByHandle(handle: "lawn-under-5000") { ${fields} }
      heavy: collectionByHandle(handle: "heavy") { ${fields} }
    }`);
    // Best selling is the store's own order, kept by hand.
    expect(data?.eid).toEqual({
      title: 'Eid edit',
      description: '<p>Picked for Eid.</p>',
      sortOrder: 'MANUAL',
      seo: { title: 'Eid edit 2026' },
      ruleSet: null,
      products: { nodes: [{ handle: 'silk-dupatta' }, { handle: 'lawn-suit' }] },
    });
    expect(data?.lawn).toMatchObject({
      sortOrder: 'PRICE_ASC',
      ruleSet: {
        appliedDisjunctively: false,
        rules: [
          { column: 'VARIANT_PRICE', relation: 'LESS_THAN' },
          { column: 'TAG', relation: 'EQUALS', condition: 'lawn' },
        ],
      },
      products: { nodes: [{ handle: 'lawn-suit' }] },
    });
    // A smart collection sorted by hand at Shopify is newest first; its weight is in grams.
    expect(data?.heavy).toMatchObject({
      sortOrder: 'CREATED_DESC',
      ruleSet: {
        appliedDisjunctively: true,
        rules: [{ column: 'VARIANT_WEIGHT', relation: 'GREATER_THAN', condition: '1500' }],
      },
    });

    // Again: the collections are there, and left as they are.
    expect((await gql(IMPORT, variables)).data?.collectionsImportFromShopify).toMatchObject({
      created: 0,
      skipped: 3,
      collectionErrors: [refusal],
    });
  });
});

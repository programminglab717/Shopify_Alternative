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
  ordersImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    orders created skipped linked dryRun
    userErrors { field code message }
  }
}`;

const money = (amount: string) => ({ shopMoney: { amount } });

/** An order of a customer the shop has, and one of a number it has not, as Shopify writes them. */
const LINES = [
  {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2025-03-20T09:00:00Z',
    cancelledAt: null,
    currencyCode: 'PKR',
    email: 'ayesha@example.pk',
    phone: '+923001234567',
    note: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    customer: null,
    shippingAddress: {
      name: 'Ayesha Khan',
      phone: '+923001234567',
      address1: 'House 12, Street 4',
      city: 'Lahore',
      province: 'Punjab',
      countryCodeV2: 'PK',
    },
    subtotalPriceSet: money('9000.0'),
    totalShippingPriceSet: money('250.0'),
    totalDiscountsSet: money('0.0'),
    totalPriceSet: money('9250.0'),
  },
  {
    id: 'gid://shopify/LineItem/11',
    title: 'Lawn suit',
    variantTitle: 'M',
    sku: null,
    quantity: 2,
    originalUnitPriceSet: money('4500.0'),
    __parentId: 'gid://shopify/Order/1',
  },
  {
    id: 'gid://shopify/Order/2',
    name: '#1002',
    createdAt: '2025-04-01T09:00:00Z',
    cancelledAt: null,
    currencyCode: 'PKR',
    email: null,
    phone: '0333 5551234',
    note: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    customer: null,
    shippingAddress: null,
    subtotalPriceSet: money('1200.0'),
    totalShippingPriceSet: money('0.0'),
    totalDiscountsSet: money('0.0'),
    totalPriceSet: money('1200.0'),
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
              bulkOperation: { id: 'gid://shopify/BulkOperation/8', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/8',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/orders.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: orders from a Shopify store's Admin API", () => {
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
      [shop, hash, hint, ['write_orders', 'read_orders', 'write_customers', 'read_customers']],
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

  it("keeps the store's orders as past orders, on their customers' pages, once (ADR-786)", async () => {
    const made = await gql(
      `mutation { customerCreate(input: { phone: "0300 1234567", name: "Ayesha" }) {
        customer { id } userErrors { message } } }`,
    );
    const customerId = made.data?.customerCreate.customer.id as string;
    const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
    expect(
      (await gql(IMPORT, { ...variables, dryRun: true })).data?.ordersImportFromShopify,
    ).toEqual({ orders: 2, created: 2, skipped: 0, linked: 0, dryRun: true, userErrors: [] });
    expect((await gql(IMPORT, variables)).data?.ordersImportFromShopify).toMatchObject({
      created: 2,
      skipped: 0,
      linked: 1,
    });

    const { data } = await gql(
      `query ($id: ID!) {
        pastOrders(first: 5) { nodes { name total { amount currencyCode } customerId } }
        customer(id: $id) {
          numberOfOrders
          pastOrders { nodes { name financialStatus fulfillmentStatus lines { title quantity price { amount } } shippingAddress { city } } }
        }
      }`,
      { id: customerId },
    );
    expect(data?.pastOrders.nodes).toEqual([
      { name: '#1002', total: { amount: '1200.00', currencyCode: 'PKR' }, customerId: null },
      { name: '#1001', total: { amount: '9250.00', currencyCode: 'PKR' }, customerId },
    ]);
    // On her page, beside her orders here, which they are not.
    expect(data?.customer).toEqual({
      numberOfOrders: 0,
      pastOrders: {
        nodes: [
          {
            name: '#1001',
            financialStatus: 'PAID',
            fulfillmentStatus: 'FULFILLED',
            lines: [{ title: 'Lawn suit', quantity: 2, price: { amount: '4500.00' } }],
            shippingAddress: { city: 'Lahore' },
          },
        ],
      },
    });

    // Again: kept once.
    expect((await gql(IMPORT, variables)).data?.ordersImportFromShopify).toMatchObject({
      created: 0,
      skipped: 2,
    });
  });
});

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
  discountsImportFromShopify(store: $store, accessToken: $accessToken, dryRun: $dryRun) {
    discounts created skipped expired dryRun
    discountErrors { discount message }
    userErrors { field code message }
  }
}`;

const common = (title: string, codes: string[], status = 'ACTIVE') => ({
  title,
  status,
  startsAt: '2026-03-01T00:00:00Z',
  endsAt: null,
  usageLimit: null,
  asyncUsageCount: 0,
  appliesOncePerCustomer: false,
  codesCount: { count: codes.length },
  codes: { nodes: codes.map((code) => ({ code })) },
  minimumRequirement: null,
});

/**
 * A percentage off a collection with uses left, free delivery, buy two get one, a code the shop
 * has, an amount off each item, one that ended, and one an app made.
 */
const NODES = [
  {
    __typename: 'DiscountCodeBasic',
    ...common('Eid 10%', ['EID10']),
    usageLimit: 100,
    asyncUsageCount: 40,
    appliesOncePerCustomer: true,
    minimumRequirement: { greaterThanOrEqualToSubtotal: { amount: '3000.0' } },
    customerGets: {
      value: { percentage: 0.1 },
      items: { collections: { nodes: [{ handle: 'lawn' }] } },
    },
  },
  { __typename: 'DiscountCodeFreeShipping', ...common('Free delivery', ['FREESHIP']) },
  {
    __typename: 'DiscountCodeBxgy',
    ...common('Buy 2 get 1', ['B2G1']),
    customerBuys: {
      value: { quantity: '2' },
      items: { products: { nodes: [{ handle: 'lawn-suit' }] } },
    },
    customerGets: {
      value: { quantity: { quantity: '1' }, effect: { percentage: 1 } },
      items: { allItems: true },
    },
  },
  {
    __typename: 'DiscountCodeBasic',
    ...common('Rs 500 off', ['SAVE500']),
    customerGets: {
      value: { amount: { amount: '500.0' }, appliesOnEachItem: false },
      items: { allItems: true },
    },
  },
  {
    __typename: 'DiscountCodeBasic',
    ...common('Rs 100 off each', ['EACH100']),
    customerGets: {
      value: { amount: { amount: '100.0' }, appliesOnEachItem: true },
      items: { allItems: true },
    },
  },
  {
    __typename: 'DiscountCodeBasic',
    ...common('Last Eid', ['EID2025'], 'EXPIRED'),
    customerGets: { value: { percentage: 0.2 }, items: { allItems: true } },
  },
  { __typename: 'DiscountCodeApp', ...common('By an app', ['APP1']) },
];

const shopify = new ShopifyStores(
  async (_input, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas', currencyCode: 'PKR' } }
      : {
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: NODES.map((codeDiscount) => ({ codeDiscount })),
          },
        };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)(
  "Admin GraphQL API: discount codes from a Shopify store's Admin API",
  () => {
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
        [
          shop,
          hash,
          hint,
          ['write_discounts', 'read_discounts', 'write_products', 'read_products'],
        ],
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

    it("counts the store's codes, then makes them with what they take off and are for (ADR-756)", async () => {
      const product = await gql(
        `mutation { productCreate(input: { title: "Lawn suit", status: ACTIVE, variants: [{ price: "4,500" }] }) {
         product { id } } }`,
      );
      const collection = await gql(
        `mutation { collectionCreate(input: { title: "Lawn" }) { collection { id } } }`,
      );
      const taken = await gql(
        `mutation { discountCodeCreate(discountCode: { code: "SAVE500", amount: "500" }) {
         userErrors { message } } }`,
      );
      expect(taken.data?.discountCodeCreate.userErrors).toEqual([]);

      const variables = { store: 'zari-kurtas', accessToken: 'shpat_1' };
      const refusals = [
        {
          discount: 'Rs 100 off each',
          message: "It takes an amount off each item, which the shop's codes take off the order",
        },
        { discount: 'By an app', message: 'An app made it, which the shop has not' },
      ];
      expect(
        (await gql(IMPORT, { ...variables, dryRun: true })).data?.discountsImportFromShopify,
      ).toEqual({
        discounts: 7,
        created: 3,
        skipped: 1,
        expired: 1,
        dryRun: true,
        discountErrors: refusals,
        userErrors: [],
      });
      expect((await gql(IMPORT, variables)).data?.discountsImportFromShopify).toMatchObject({
        created: 3,
        skipped: 1,
        expired: 1,
        discountErrors: refusals,
      });

      const { data } = await gql(`{
      discountCodes(first: 10) {
        nodes {
          code title kind percentage minimumSubtotal { amount } usageLimit oncePerCustomer
          productIds collectionIds buyQuantity getQuantity startsAt
        }
      }
    }`);
      const byCode = Object.fromEntries(
        (data?.discountCodes.nodes as Json[]).map((code) => [code.code, code]),
      );
      expect(Object.keys(byCode).sort()).toEqual(['B2G1', 'EID10', 'FREESHIP', 'SAVE500']);
      // The uses it had left at Shopify, and the collection it was for.
      expect(byCode.EID10).toMatchObject({
        title: 'Eid 10%',
        percentage: 10,
        usageLimit: 60,
        oncePerCustomer: true,
        collectionIds: [collection.data?.collectionCreate.collection.id],
        startsAt: '2026-03-01T00:00:00.000Z',
      });
      expect(byCode.EID10.minimumSubtotal.amount).toMatch(/^3,?000/);
      expect(byCode.B2G1).toMatchObject({
        percentage: 100,
        buyQuantity: 2,
        getQuantity: 1,
        productIds: [product.data?.productCreate.product.id],
      });

      // Again: the codes are here, and left as they are.
      expect((await gql(IMPORT, variables)).data?.discountsImportFromShopify).toMatchObject({
        created: 0,
        skipped: 4,
      });
    });
  },
);

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SCHEDULE = `mutation ($productId: ID!, $publishAt: DateTime) {
  productSchedulePublish(productId: $productId, publishAt: $publishAt) {
    product { status publishAt }
    userErrors { field code }
  }
}`;

describe.skipIf(!server)(
  'Admin GraphQL API: drafts put on sale at a time ahead (CAT-17, ADR-441)',
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    const shop = newId();
    const tokens = { write: '', read: '', orders: '' };

    async function issueToken(scopes: string[]): Promise<string> {
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
        [shop, hash, hint, scopes],
      );
      return token;
    }

    async function gql(token: string, query: string, variables?: Record<string, unknown>) {
      const response = await app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
        payload: { query, variables },
      });
      return response.json<{ data?: Json; errors?: Json[] }>();
    }

    async function data(token: string, query: string, variables?: Record<string, unknown>) {
      const body = await gql(token, query, variables);
      expect(body.errors).toBeUndefined();
      return Object.values(body.data ?? {})[0] as Json;
    }

    async function product(title: string, status = 'DRAFT'): Promise<string> {
      const created = await data(
        tokens.write,
        `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id } }
      }`,
        { input: { title, status } },
      );
      return created.product.id;
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      tokens.write = await issueToken(['write_products']);
      tokens.read = await issueToken(['read_products']);
      tokens.orders = await issueToken(['read_orders']);
      api = await startTestApi(testDb);
      app = api.app;
    });

    afterAll(async () => {
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("sets a draft's time, reads it on the product, and takes it away", async () => {
      const drop = await product('Eid lawn drop');
      const at = new Date(Date.now() + 3_600_000).toISOString();
      expect(await data(tokens.write, SCHEDULE, { productId: drop, publishAt: at })).toEqual({
        product: { status: 'DRAFT', publishAt: at },
        userErrors: [],
      });
      const read = await data(
        tokens.read,
        `query { products(first: 10) { nodes { title publishAt } } }`,
      );
      expect(read.nodes).toEqual([{ title: 'Eid lawn drop', publishAt: at }]);
      expect(await data(tokens.write, SCHEDULE, { productId: drop, publishAt: null })).toEqual({
        product: { status: 'DRAFT', publishAt: null },
        userErrors: [],
      });
    });

    it('says what is wrong, and asks the scopes products need', async () => {
      const drop = await product('Drop');
      const onSale = await product('Kurta', 'ACTIVE');
      const past = new Date(Date.now() - 60_000).toISOString();
      const ahead = new Date(Date.now() + 3_600_000).toISOString();
      expect(await data(tokens.write, SCHEDULE, { productId: drop, publishAt: past })).toEqual({
        product: null,
        userErrors: [{ field: ['publishAt'], code: 'INVALID' }],
      });
      expect(await data(tokens.write, SCHEDULE, { productId: onSale, publishAt: ahead })).toEqual({
        product: null,
        userErrors: [{ field: ['productId'], code: 'INVALID' }],
      });
      expect(await data(tokens.write, SCHEDULE, { productId: 'prod_x', publishAt: ahead })).toEqual(
        { product: null, userErrors: [{ field: ['productId'], code: 'NOT_FOUND' }] },
      );
      const denied = await gql(tokens.read, SCHEDULE, { productId: drop, publishAt: null });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
      const unread = await gql(
        tokens.orders,
        `query ($id: ID!) { product(id: $id) { publishAt } }`,
        { id: drop },
      );
      expect(unread.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    });
  },
);

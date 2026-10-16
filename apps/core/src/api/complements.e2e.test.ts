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

const SET = `mutation ($productId: ID!, $complementIds: [ID!]!) {
  productComplementsSet(productId: $productId, complementIds: $complementIds) {
    complementaryProducts { id title }
    userErrors { field code }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: complementary products (MKT-09, ADR-435)', () => {
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

  async function product(title: string): Promise<string> {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id } }
      }`,
      { input: { title, status: 'ACTIVE' } },
    );
    return created.product.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
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

  it('pairs a product with others, in order, reads them on the product, and pairs none again', async () => {
    const kurta = await product('Lawn kurta');
    const dupatta = await product('Chiffon dupatta');
    const khussa = await product('Khussa');
    expect(
      await data(tokens.write, SET, { productId: kurta, complementIds: [khussa, dupatta] }),
    ).toEqual({
      complementaryProducts: [
        { id: khussa, title: 'Khussa' },
        { id: dupatta, title: 'Chiffon dupatta' },
      ],
      userErrors: [],
    });
    const read = await data(
      tokens.read,
      `query { products(first: 10) { nodes { title complementaryProducts { title } } } }`,
    );
    expect(read.nodes).toEqual(
      expect.arrayContaining([
        {
          title: 'Lawn kurta',
          complementaryProducts: [{ title: 'Khussa' }, { title: 'Chiffon dupatta' }],
        },
        { title: 'Khussa', complementaryProducts: [] },
      ]),
    );
    expect(await data(tokens.write, SET, { productId: kurta, complementIds: [] })).toEqual({
      complementaryProducts: [],
      userErrors: [],
    });
    const { rows } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE event_type = 'product_complements.updated'`,
    );
    expect(rows).toHaveLength(2);
  });

  it('says what is wrong, and asks the scopes products need', async () => {
    const kurta = await product('Kurta');
    expect(
      await data(tokens.write, SET, {
        productId: kurta,
        complementIds: [kurta, 'gid://hatti/Product/x'],
      }),
    ).toEqual({
      complementaryProducts: null,
      userErrors: [{ field: ['complementIds', '0'], code: 'INVALID' }],
    });
    expect(await data(tokens.write, SET, { productId: kurta, complementIds: ['prod_x'] })).toEqual({
      complementaryProducts: null,
      userErrors: [{ field: ['complementIds', '0'], code: 'NOT_FOUND' }],
    });
    const denied = await gql(tokens.read, SET, { productId: kurta, complementIds: [] });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const unread = await gql(
      tokens.orders,
      `query ($id: ID!) { product(id: $id) { complementaryProducts { id } } }`,
      { id: kurta },
    );
    expect(unread.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});

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

const SET = `mutation ($productId: ID!, $components: [ProductBundleComponentInput!]!) {
  productBundleSet(productId: $productId, components: $components) {
    bundle { productId complete components { variantId productTitle quantity } }
    userErrors { field code }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: bundles (CAT-11, ADR-409)', () => {
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

  /** A product of one variant: its ID and its variant's. */
  async function product(title: string): Promise<[string, string]> {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id variants { id } } }
      }`,
      { input: { title, status: 'ACTIVE' } },
    );
    return [created.product.id, created.product.variants[0].id];
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

  it('makes a product a bundle of others, reads it on the product, and no bundle again', async () => {
    const [set] = await product('Eid 3-piece set');
    const [, shirt] = await product('Lawn shirt');
    const [, trouser] = await product('Cotton trouser');
    expect(
      await data(tokens.write, SET, {
        productId: set,
        components: [
          { variantId: shirt, quantity: 1 },
          { variantId: trouser, quantity: 2 },
        ],
      }),
    ).toEqual({
      bundle: {
        productId: set,
        complete: true,
        components: [
          { variantId: shirt, productTitle: 'Lawn shirt', quantity: 1 },
          { variantId: trouser, productTitle: 'Cotton trouser', quantity: 2 },
        ],
      },
      userErrors: [],
    });
    const read = await data(
      tokens.read,
      `query ($id: ID!) { product(id: $id) { bundle { components { quantity } } } }`,
      { id: set },
    );
    expect(read).toEqual({ bundle: { components: [{ quantity: 1 }, { quantity: 2 }] } });
    expect(
      await data(tokens.read, `query ($id: ID!) { product(id: $id) { bundle { complete } } }`, {
        id: (await product('Plain'))[0],
      }),
    ).toEqual({ bundle: null });
    expect(await data(tokens.write, SET, { productId: set, components: [] })).toEqual({
      bundle: null,
      userErrors: [],
    });
    const { rows } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events WHERE event_type = 'product_bundle.updated'`,
    );
    expect(rows).toHaveLength(2);
  });

  it('says what is wrong, and asks the scopes products need', async () => {
    const [set] = await product('Gift box');
    const [, shirt] = await product('Shirt');
    expect(
      await data(tokens.write, SET, {
        productId: set,
        components: [
          { variantId: shirt, quantity: 1 },
          { variantId: 'var_x', quantity: 1 },
        ],
      }),
    ).toEqual({
      bundle: null,
      userErrors: [{ field: ['components', '1', 'variantId'], code: 'NOT_FOUND' }],
    });
    const denied = await gql(tokens.read, SET, { productId: set, components: [] });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const unread = await gql(
      tokens.orders,
      `query ($id: ID!) { product(id: $id) { bundle { complete } } }`,
      { id: set },
    );
    expect(unread.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});

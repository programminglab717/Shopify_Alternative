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

const SET = `mutation ($id: ID, $input: CombinedListingInput!) {
  combinedListingSet(id: $id, input: $input) {
    combinedListing { id optionName products { productId value product { title } } }
    userErrors { field code }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: combined listings (CAT-23, ADR-799)', () => {
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

  it('shows products as one listing, read on each product, changed and deleted', async () => {
    const maroon = await product('Lawn suit, maroon');
    const teal = await product('Lawn suit, teal');
    const made = await data(tokens.write, SET, {
      input: {
        optionName: 'Colour',
        products: [
          { productId: maroon, value: 'Maroon' },
          { productId: teal, value: 'Teal' },
        ],
      },
    });
    expect(made.userErrors).toEqual([]);
    expect(made.combinedListing).toMatchObject({
      id: expect.stringMatching(/^cmbl_/) as unknown,
      optionName: 'Colour',
      products: [
        { productId: maroon, value: 'Maroon', product: { title: 'Lawn suit, maroon' } },
        { productId: teal, value: 'Teal', product: { title: 'Lawn suit, teal' } },
      ],
    });
    const id = made.combinedListing.id as string;
    const read = await data(
      tokens.read,
      `query { products(first: 10) { nodes { title combinedListing { id optionName } } } }`,
    );
    expect(read.nodes).toEqual(
      expect.arrayContaining([
        { title: 'Lawn suit, teal', combinedListing: { id, optionName: 'Colour' } },
      ]),
    );
    expect(
      (await data(tokens.read, '{ combinedListings { id } }')).map((each: Json) => each.id),
    ).toEqual([id]);

    // One product alone, or another shop's ID, is refused; the IDs are said where they are.
    const refused = await data(tokens.write, SET, {
      id,
      input: {
        optionName: 'Colour',
        products: [
          { productId: maroon, value: 'Maroon' },
          { productId: 'prod_nope', value: 'Teal' },
        ],
      },
    });
    expect(refused).toEqual({
      combinedListing: null,
      userErrors: [{ field: ['input', 'products', '1', 'productId'], code: 'NOT_FOUND' }],
    });
    const denied = await gql(tokens.orders, SET, {
      input: { optionName: 'Colour', products: [] },
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const deleted = await data(
      tokens.write,
      `mutation ($id: ID!) { combinedListingDelete(id: $id) { deletedCombinedListingId userErrors { code } } }`,
      { id },
    );
    expect(deleted).toEqual({ deletedCombinedListingId: id, userErrors: [] });
    expect(
      await data(tokens.read, `query ($id: ID!) { combinedListing(id: $id) { id } }`, { id }),
    ).toBeNull();
  });
});

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SET = `mutation ($groups: [SearchSynonymGroupInput!]!) {
  searchSynonymsSet(groups: $groups) {
    searchSynonyms { words }
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: search synonyms (SRC-04, ADR-685)', () => {
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
      `mutation ($input: ProductCreateInput!) { productCreate(input: $input) { product { id } } }`,
      { input: { title, status: 'ACTIVE' } },
    );
    return fromPublicId(created.product.id, 'product');
  }

  async function search(q: string): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/storefront/shops/${shop}/search?q=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${TEST_STOREFRONT_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ productIds: string[] }>().productIds;
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

  it("keeps the shop's own synonyms, which its storefront's search finds by", async () => {
    const chappal = await product('Peshawari Chappal');
    const sandals = await product('Summer Sandals');
    expect(await search('chappal')).toEqual([chappal]);

    const set = await data(tokens.write, SET, { groups: [{ words: ['Chappal', 'sandals'] }] });
    expect(set).toEqual({ searchSynonyms: [{ words: ['Chappal', 'sandals'] }], userErrors: [] });
    expect(await data(tokens.read, '{ searchSynonyms { words } }')).toEqual([
      { words: ['Chappal', 'sandals'] },
    ]);
    expect(await search('chappal')).toEqual([chappal, sandals]);
    expect(await search('sandals')).toEqual([sandals, chappal]);

    // Refused as a whole, with what is wrong; the groups kept as they were.
    const refused = await data(tokens.write, SET, {
      groups: [{ words: ['lawn suit', 'jora'] }, { words: ['juti'] }],
    });
    expect(refused.searchSynonyms).toBeNull();
    expect(refused.userErrors).toEqual([
      { field: ['groups', '0', '0'], code: 'INVALID', message: 'lawn suit must be one word' },
      { field: ['groups', '1'], code: 'TOO_FEW', message: 'A group must have two words at least' },
    ]);
    expect(await data(tokens.read, '{ searchSynonyms { words } }')).toHaveLength(1);

    // Changing them needs the products' write scope; reading them, the read scope.
    expect((await gql(tokens.read, SET, { groups: [] })).errors?.[0]?.extensions?.code).toBe(
      'ACCESS_DENIED',
    );
    expect(
      (await gql(tokens.orders, '{ searchSynonyms { words } }')).errors?.[0]?.extensions?.code,
    ).toBe('ACCESS_DENIED');
    expect(await data(tokens.write, SET, { groups: [] })).toEqual({
      searchSynonyms: [],
      userErrors: [],
    });
    expect(await search('chappal')).toEqual([chappal]);
  });
});

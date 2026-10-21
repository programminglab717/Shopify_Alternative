import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SET = `mutation ($query: String!, $pinned: [ID!]!, $hidden: [ID!]!) {
  searchRuleSet(query: $query, pinnedProductIds: $pinned, hiddenProductIds: $hidden) {
    searchRule { id query pinnedProducts { id title } hiddenProducts { id } }
    userErrors { field code message }
  }
}`;

const DELETE = `mutation ($id: ID!) {
  searchRuleDelete(id: $id) { deletedSearchRuleId userErrors { field code message } }
}`;

describe.skipIf(!server)('Admin GraphQL API: search rules (SRC-04, ADR-692)', () => {
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

  it("pins and hides products for a term, which its storefront's search shows so", async () => {
    const lawn = await product('Eid Lawn');
    const kurta = await product('Eid Kurta');
    const dupatta = await product('Chiffon Dupatta');
    expect(await search('eid')).toEqual([kurta, lawn]);
    const id = (uuid: string) => toPublicId('product', uuid);

    const set = await data(tokens.write, SET, {
      query: 'Eid',
      pinned: [id(dupatta), id(lawn)],
      hidden: [id(kurta)],
    });
    expect(set.userErrors).toEqual([]);
    expect(set.searchRule).toMatchObject({
      query: 'Eid',
      pinnedProducts: [{ title: 'Chiffon Dupatta' }, { title: 'Eid Lawn' }],
      hiddenProducts: [{ id: id(kurta) }],
    });
    expect(set.searchRule.id).toMatch(/^srch_/);
    expect(await search('EID')).toEqual([dupatta, lawn]);
    expect(await data(tokens.read, '{ searchRules { query pinnedProducts { title } } }')).toEqual([
      { query: 'Eid', pinnedProducts: [{ title: 'Chiffon Dupatta' }, { title: 'Eid Lawn' }] },
    ]);

    // Refused with what is wrong; an ID of no product is said where it is.
    const refused = await data(tokens.write, SET, {
      query: 'lawn',
      pinned: [id(lawn), 'gid://nothing'],
      hidden: [],
    });
    expect(refused).toEqual({
      searchRule: null,
      userErrors: [
        { field: ['pinnedProductIds', '1'], code: 'NOT_FOUND', message: 'Product not found' },
      ],
    });

    // Changing them needs the products' write scope; reading them, the read scope.
    expect(
      (await gql(tokens.read, DELETE, { id: set.searchRule.id })).errors?.[0]?.extensions?.code,
    ).toBe('ACCESS_DENIED');
    expect((await gql(tokens.orders, '{ searchRules { id } }')).errors?.[0]?.extensions?.code).toBe(
      'ACCESS_DENIED',
    );
    expect(await data(tokens.write, DELETE, { id: set.searchRule.id })).toEqual({
      deletedSearchRuleId: set.searchRule.id,
      userErrors: [],
    });
    expect(await search('eid')).toEqual([kurta, lawn]);
    expect((await data(tokens.write, DELETE, { id: set.searchRule.id })).userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Search rule not found' },
    ]);
  });
});

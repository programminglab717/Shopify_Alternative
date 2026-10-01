import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SAVED_SEARCH = 'id name query resourceType searchTerms filters { key value }';

describe.skipIf(!server)('Admin GraphQL API: saved order searches', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { writer: '', reader: '' };

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
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  /** A mutation's payload, failing the test on GraphQL errors. */
  async function mutate(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.writer = await issueToken(['write_orders']);
    tokens.reader = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps the shop's searches of its orders by name, as Shopify's saved searches", async () => {
    const CREATE = `mutation ($input: SavedSearchCreateInput!) {
      savedSearchCreate(input: $input) { savedSearch { ${SAVED_SEARCH} } userErrors { field code message } }
    }`;
    const input = {
      name: 'VIP to pack',
      query: 'tag:vip -risk_level:high ayesha',
      resourceType: 'ORDER',
    };
    // Reading orders lets staff open saved searches, not keep them.
    const denied = await gql(tokens.reader, CREATE, { input });
    expect(denied.errors?.[0]?.message).toContain('write_orders');

    const created = await mutate(tokens.writer, CREATE, { input });
    expect(created).toEqual({
      savedSearch: {
        id: expect.stringMatching(/^svs_/),
        name: 'VIP to pack',
        query: 'tag:vip -risk_level:high ayesha',
        resourceType: 'ORDER',
        searchTerms: 'ayesha',
        filters: [
          { key: 'tag', value: 'vip' },
          { key: '-risk_level', value: 'high' },
        ],
      },
      userErrors: [],
    });
    const invalid = await mutate(tokens.writer, CREATE, {
      input: { name: 'Packed', query: 'stage:packed', resourceType: 'ORDER' },
    });
    expect(invalid).toMatchObject({
      savedSearch: null,
      userErrors: [{ field: ['input', 'query'], code: 'INVALID' }],
    });

    // Its query opens its view of the orders, as orders(query:) reads it.
    const listed = await gql(
      tokens.reader,
      `{ orderSavedSearches(first: 5) { nodes { name query } pageInfo { hasNextPage } } }`,
    );
    expect(listed.data?.orderSavedSearches).toEqual({
      nodes: [{ name: 'VIP to pack', query: 'tag:vip -risk_level:high ayesha' }],
      pageInfo: { hasNextPage: false },
    });
    const opened = await gql(
      tokens.reader,
      'query ($query: String) { orders(first: 5, query: $query) { nodes { id } } }',
      { query: created.savedSearch.query },
    );
    expect(opened.errors).toBeUndefined();

    const updated = await mutate(
      tokens.writer,
      `mutation ($input: SavedSearchUpdateInput!) {
        savedSearchUpdate(input: $input) { savedSearch { name query } userErrors { code } }
      }`,
      { input: { id: created.savedSearch.id, query: 'tag:vip' } },
    );
    expect(updated).toEqual({
      savedSearch: { name: 'VIP to pack', query: 'tag:vip' },
      userErrors: [],
    });
    const DELETE = `mutation ($input: SavedSearchDeleteInput!) {
      savedSearchDelete(input: $input) { deletedSavedSearchId userErrors { field code } }
    }`;
    expect(await mutate(tokens.writer, DELETE, { input: { id: created.savedSearch.id } })).toEqual({
      deletedSavedSearchId: created.savedSearch.id,
      userErrors: [],
    });
    expect(await mutate(tokens.writer, DELETE, { input: { id: created.savedSearch.id } })).toEqual({
      deletedSavedSearchId: null,
      userErrors: [{ field: ['input', 'id'], code: 'NOT_FOUND' }],
    });
  });
});

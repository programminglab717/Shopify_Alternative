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

const UPDATE = `mutation ($minutes: Int) {
  checkoutStockHoldUpdate(minutes: $minutes) {
    checkoutStockHold { minutes } userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: stock held at checkout (CHK-02, ADR-715)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { settings: '', orders: '' };

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

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.settings = await issueToken(['read_settings', 'write_settings']);
    tokens.orders = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("sets how long checkouts hold their carts' stock, from 5 to 60 minutes or none", async () => {
    const read = `{ checkoutStockHold { minutes } }`;
    expect((await gql(tokens.settings, read)).data).toEqual({
      checkoutStockHold: { minutes: null },
    });
    expect((await gql(tokens.settings, UPDATE, { minutes: 90 })).data).toEqual({
      checkoutStockHoldUpdate: {
        checkoutStockHold: null,
        userErrors: [
          { field: ['minutes'], code: 'INVALID', message: 'Hold stock for 5 to 60 minutes' },
        ],
      },
    });
    expect((await gql(tokens.settings, UPDATE, { minutes: 20 })).data).toEqual({
      checkoutStockHoldUpdate: { checkoutStockHold: { minutes: 20 }, userErrors: [] },
    });
    expect((await gql(tokens.settings, read)).data).toEqual({
      checkoutStockHold: { minutes: 20 },
    });
    // A token without the settings' scopes reads and changes nothing.
    expect((await gql(tokens.orders, read)).errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect((await gql(tokens.settings, UPDATE, { minutes: null })).data).toEqual({
      checkoutStockHoldUpdate: { checkoutStockHold: { minutes: null }, userErrors: [] },
    });
  });
});

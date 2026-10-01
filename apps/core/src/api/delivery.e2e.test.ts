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

const FIELDS = 'charge { amount } freeAbove { amount } zones { name cities charge { amount } }';
const READ = `{ deliverySettings { ${FIELDS} } }`;
const UPDATE = `mutation ($input: DeliverySettingsUpdateInput!) {
  deliverySettingsUpdate(input: $input) {
    deliverySettings { ${FIELDS} } userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: delivery charges', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', orders: '', b: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as {
      data?: Record<string, Json> | null;
      errors?: { extensions?: { code?: string } }[];
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_settings']);
    tokens.reader = await issueToken(shopA, ['read_settings']);
    tokens.orders = await issueToken(shopA, ['write_orders']);
    tokens.b = await issueToken(shopB, ['write_settings']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sets what the shop charges for delivery, as the settings scopes allow', async () => {
    const read = async (token: string) => (await gql(token, READ)).data?.deliverySettings;
    expect(await read(tokens.reader)).toEqual({
      charge: { amount: '0.00' },
      freeAbove: null,
      zones: [],
    });

    const set = await gql(tokens.a, UPDATE, {
      input: {
        charge: '250',
        freeAbove: '5,000',
        zones: [{ name: 'Twin cities', cities: ['isb', 'Pindi'], charge: '200' }],
      },
    });
    const saved = {
      charge: { amount: '250.00' },
      freeAbove: { amount: '5000.00' },
      zones: [
        { name: 'Twin cities', cities: ['Islamabad', 'Rawalpindi'], charge: { amount: '200.00' } },
      ],
    };
    expect(set.data?.deliverySettingsUpdate).toEqual({ deliverySettings: saved, userErrors: [] });
    const refused = await gql(tokens.a, UPDATE, {
      input: { zones: [{ name: 'North', cities: ['Gotham'], charge: '300' }] },
    });
    expect(refused.data?.deliverySettingsUpdate).toEqual({
      deliverySettings: null,
      userErrors: [
        {
          field: ['zones', '0', 'cities', '0'],
          code: 'INVALID',
          message: '"Gotham" is not a city of Pakistan we know',
        },
      ],
    });
    expect(await read(tokens.reader)).toEqual(saved);
    // Another shop's are its own.
    expect((await read(tokens.b)).zones).toEqual([]);

    for (const [token, query] of [
      [tokens.orders, READ],
      [tokens.reader, 'mutation { deliverySettingsUpdate(input: {}) { userErrors { code } } }'],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });

  it("sets the shop's rules for cash on delivery, as the settings scopes allow", async () => {
    const fields = 'maxOrderTotal { amount } unavailableCities refusedDeliveriesLimit';
    const read = `{ cashOnDeliverySettings { ${fields} } }`;
    const update = `mutation ($input: CashOnDeliverySettingsInput!) {
      cashOnDeliverySettingsUpdate(input: $input) {
        cashOnDeliverySettings { ${fields} } userErrors { field code message }
      }
    }`;
    expect((await gql(tokens.reader, read)).data?.cashOnDeliverySettings).toEqual({
      maxOrderTotal: null,
      unavailableCities: [],
      refusedDeliveriesLimit: null,
    });
    const set = await gql(tokens.a, update, {
      input: { maxOrderTotal: '25,000', unavailableCities: ['gilgit'], refusedDeliveriesLimit: 2 },
    });
    expect(set.data?.cashOnDeliverySettingsUpdate).toEqual({
      cashOnDeliverySettings: {
        maxOrderTotal: { amount: '25000.00' },
        unavailableCities: ['Gilgit'],
        refusedDeliveriesLimit: 2,
      },
      userErrors: [],
    });
    const refused = await gql(tokens.a, update, { input: { unavailableCities: ['Gotham'] } });
    expect(refused.data?.cashOnDeliverySettingsUpdate.userErrors).toEqual([
      {
        field: ['input', 'unavailableCities', '0'],
        code: 'INVALID',
        message: '"Gotham" is not a city of Pakistan we know',
      },
    ]);
    expect((await gql(tokens.b, read)).data?.cashOnDeliverySettings.unavailableCities).toEqual([]);
    for (const [token, query] of [
      [tokens.orders, read],
      [
        tokens.reader,
        'mutation { cashOnDeliverySettingsUpdate(input: {}) { userErrors { code } } }',
      ],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });
});

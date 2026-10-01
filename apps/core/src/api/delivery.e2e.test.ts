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
    const fields =
      'maxOrderTotal { amount } unavailableCities unavailableProductTags refusedDeliveriesLimit ' +
      'fee { amount }';
    const read = `{ cashOnDeliverySettings { ${fields} } }`;
    const update = `mutation ($input: CashOnDeliverySettingsInput!) {
      cashOnDeliverySettingsUpdate(input: $input) {
        cashOnDeliverySettings { ${fields} } userErrors { field code message }
      }
    }`;
    expect((await gql(tokens.reader, read)).data?.cashOnDeliverySettings).toEqual({
      maxOrderTotal: null,
      unavailableCities: [],
      unavailableProductTags: [],
      refusedDeliveriesLimit: null,
      fee: { amount: '0.00' },
    });
    const set = await gql(tokens.a, update, {
      input: {
        maxOrderTotal: '25,000',
        unavailableCities: ['gilgit'],
        unavailableProductTags: ['pre-order', 'Pre-Order'],
        refusedDeliveriesLimit: 2,
        fee: '100',
      },
    });
    expect(set.data?.cashOnDeliverySettingsUpdate).toEqual({
      cashOnDeliverySettings: {
        maxOrderTotal: { amount: '25000.00' },
        unavailableCities: ['Gilgit'],
        unavailableProductTags: ['pre-order'],
        refusedDeliveriesLimit: 2,
        fee: { amount: '100.00' },
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

  it("asks for an advance on cash on delivery, paid into the shop's bank account", async () => {
    const update = `mutation ($input: CashOnDeliverySettingsInput!) {
      cashOnDeliverySettingsUpdate(input: $input) {
        cashOnDeliverySettings {
          advance {
            kind amount { amount } percentage above { amount } cities refusedDeliveries
          }
        }
        userErrors { field code message }
      }
    }`;
    const advance = async (input: unknown) =>
      (await gql(tokens.a, update, { input: { advance: input } })).data
        ?.cashOnDeliverySettingsUpdate;
    expect(await advance({ amount: '500' })).toEqual({
      cashOnDeliverySettings: null,
      userErrors: [
        {
          field: ['input', 'advance'],
          code: 'INVALID',
          message: "An advance is paid into the shop's bank account: give its account first",
        },
      ],
    });
    // Its account, without offering bank transfer.
    const account = await gql(
      tokens.a,
      `mutation ($input: BankTransferSettingsInput!) {
        bankTransferSettingsUpdate(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          account: { title: 'Shop A', bankName: 'Meezan Bank', iban: 'PK36SCBL0000001123456702' },
        },
      },
    );
    expect(account.data?.bankTransferSettingsUpdate.userErrors).toEqual([]);
    expect(await advance({ percentage: 20, above: '10,000' })).toEqual({
      cashOnDeliverySettings: {
        advance: {
          kind: 'PERCENTAGE',
          amount: null,
          percentage: 20,
          above: { amount: '10000.00' },
          cities: [],
          refusedDeliveries: null,
        },
      },
      userErrors: [],
    });
    // Only to cities it names, as addresses spell them, and of customers who refused before.
    expect(
      await advance({ amount: '300', cities: ['koita', 'Gilgit'], refusedDeliveries: 2 }),
    ).toMatchObject({
      cashOnDeliverySettings: {
        advance: { kind: 'FIXED_AMOUNT', cities: ['Quetta', 'Gilgit'], refusedDeliveries: 2 },
      },
      userErrors: [],
    });
    expect(await advance({ amount: '300', cities: ['Atlantis'], refusedDeliveries: 0 })).toEqual({
      cashOnDeliverySettings: null,
      userErrors: [
        {
          field: ['input', 'advance', 'cities', '0'],
          code: 'INVALID',
          message: '"Atlantis" is not a city of Pakistan we know',
        },
        {
          field: ['input', 'advance', 'refusedDeliveries'],
          code: 'INVALID',
          message: 'Refused deliveries must be a whole number from 1 to 100',
        },
      ],
    });
    expect(await advance({ amount: '500' })).toMatchObject({
      cashOnDeliverySettings: {
        advance: {
          kind: 'FIXED_AMOUNT',
          amount: { amount: '500.00' },
          percentage: null,
          above: null,
          cities: [],
          refusedDeliveries: null,
        },
      },
    });
    expect(
      (await gql(tokens.reader, '{ cashOnDeliverySettings { advance { kind } } }')).data
        ?.cashOnDeliverySettings,
    ).toEqual({ advance: { kind: 'FIXED_AMOUNT' } });
    expect(await advance({ deliveryCharge: true, percentage: 5 })).toEqual({
      cashOnDeliverySettings: null,
      userErrors: [
        {
          field: ['input', 'advance'],
          code: 'INVALID',
          message: 'Ask for an amount, a percentage or the delivery charge: one of them',
        },
      ],
    });
    expect(await advance({ deliveryCharge: true })).toMatchObject({
      cashOnDeliverySettings: { advance: { kind: 'DELIVERY_CHARGE', above: null } },
    });
    expect(await advance(null)).toEqual({
      cashOnDeliverySettings: { advance: null },
      userErrors: [],
    });
  });

  it("sets the badges the checkout's page shows, as the settings scopes allow", async () => {
    const update = `mutation ($badges: [CheckoutTrustBadgeInput!]!) {
      checkoutTrustBadgesUpdate(badges: $badges) {
        checkoutTrustBadges { kind days } userErrors { field code message }
      }
    }`;
    const read = '{ checkoutTrustBadges { kind days } }';
    expect((await gql(tokens.reader, read)).data?.checkoutTrustBadges).toEqual([]);
    const set = await gql(tokens.a, update, {
      badges: [{ kind: 'EXCHANGE', days: 7 }, { kind: 'CASH_ON_DELIVERY' }],
    });
    expect(set.data?.checkoutTrustBadgesUpdate).toEqual({
      checkoutTrustBadges: [
        { kind: 'EXCHANGE', days: 7 },
        { kind: 'CASH_ON_DELIVERY', days: null },
      ],
      userErrors: [],
    });
    const refused = await gql(tokens.a, update, {
      badges: [{ kind: 'RETURNS' }, { kind: 'WHATSAPP' }],
    });
    expect(refused.data?.checkoutTrustBadgesUpdate.userErrors).toEqual([
      {
        field: ['badges', '0', 'days'],
        code: 'BLANK',
        message: 'Say within how many days, such as 7',
      },
    ]);
    expect((await gql(tokens.reader, read)).data?.checkoutTrustBadges).toHaveLength(2);
    expect((await gql(tokens.b, read)).data?.checkoutTrustBadges).toEqual([]);
    for (const [token, query] of [
      [tokens.orders, read],
      [tokens.reader, 'mutation { checkoutTrustBadgesUpdate(badges: []) { userErrors { code } } }'],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });
});

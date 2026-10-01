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

const COD_HEALTH = `query ($from: DateTime!, $before: DateTime!, $by: CodHealthDimension) {
  codHealth(placedFrom: $from, placedBefore: $before, by: $by) {
    confirmation { placed confirmed cancelled awaiting rate }
    delivery { shipped delivered returned inTransit successRate returnRate }
    rows {
      key
      title
      confirmation { placed rate }
      delivery { shipped successRate returnRate }
    }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: COD health', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };
  const period = {
    from: new Date(Date.now() - 3_600_000).toISOString(),
    before: new Date(Date.now() + 3_600_000).toISOString(),
  };

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

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.owner = await issueToken(['write_products', 'write_orders']);
    tokens.products = await issueToken(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("says how a period's cash-on-delivery orders went, by city, product, source and courier", async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { id variants { id } }
        }
      }`,
    );
    const product = created.data?.productCreate.product;
    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      const placed = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: 1 }],
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "lhr" }
          }) { order { id } userErrors { code message } }
        }`,
        { variantId: product.variants[0].id },
      );
      ids.push(placed.data?.orderCreate.order.id);
    }
    await gql(
      tokens.owner,
      `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
      {
        id: ids[0],
      },
    );
    const fulfilled = await gql(
      tokens.owner,
      `mutation ($id: ID!) {
        orderFulfill(id: $id, input: { trackingInfo: { company: "TCS", number: "1234567890" } }) {
          fulfillment { id } userErrors { code message }
        }
      }`,
      { id: ids[0] },
    );
    await gql(
      tokens.owner,
      `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { userErrors { code } } }`,
      { id: fulfilled.data?.orderFulfill.fulfillment.id },
    );

    const byCity = await gql(tokens.owner, COD_HEALTH, { ...period, by: 'CITY' });
    expect(byCity.data?.codHealth).toEqual({
      confirmation: { placed: 2, confirmed: 1, cancelled: 0, awaiting: 1, rate: 1 },
      delivery: {
        shipped: 1,
        delivered: 1,
        returned: 0,
        inTransit: 0,
        successRate: 1,
        returnRate: 0,
      },
      rows: [
        {
          key: 'Lahore',
          title: 'Lahore',
          confirmation: { placed: 2, rate: 1 },
          delivery: { shipped: 1, successRate: 1, returnRate: 0 },
        },
      ],
    });
    const rowsBy = async (by: string) =>
      ((await gql(tokens.owner, COD_HEALTH, { ...period, by })).data?.codHealth.rows as Json[]).map(
        (row) => [row.key, row.title, row.confirmation],
      );
    expect(await rowsBy('PRODUCT')).toEqual([[product.id, 'Kurta', { placed: 2, rate: 1 }]]);
    expect(await rowsBy('SOURCE')).toEqual([['API', 'Apps', { placed: 2, rate: 1 }]]);
    expect(await rowsBy('COURIER')).toEqual([['TCS', 'TCS', null]]);

    // Nothing decided yet: no rate.
    const before = { from: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' };
    const empty = await gql(tokens.owner, COD_HEALTH, before);
    expect(empty.data?.codHealth.confirmation.rate).toBeNull();
    expect(empty.data?.codHealth.delivery.successRate).toBeNull();

    const tooLong = await gql(tokens.owner, COD_HEALTH, {
      ...before,
      before: '2027-06-01T00:00:00Z',
    });
    expect(tooLong.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(tooLong.errors?.[0]?.message).toBe('COD health covers at most 366 days at a time');

    const denied = await gql(tokens.products, COD_HEALTH, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});

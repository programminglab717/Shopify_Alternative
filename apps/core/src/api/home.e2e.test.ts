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

const HOME = `{
  home {
    toConfirm { count total { amount currencyCode } }
    toReview { count }
    toPack { count }
    toBook { count }
    returning { count }
    cashToCollect { count total { amount } }
  }
}`;

describe.skipIf(!server)("Admin GraphQL API: the admin's home", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };

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

  it('says how many orders wait for the shop, and what they come to', async () => {
    const empty = await gql(tokens.owner, HOME);
    expect(empty.data?.home).toEqual({
      toConfirm: { count: 0, total: { amount: '0.00', currencyCode: 'PKR' } },
      toReview: { count: 0 },
      toPack: { count: 0 },
      toBook: { count: 0 },
      returning: { count: 0 },
      cashToCollect: { count: 0, total: { amount: '0.00' } },
    });

    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.data?.productCreate.product.variants[0].id;
    for (let n = 0; n < 2; n++) {
      const order = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: 1 }],
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "Lahore" }
          }) { order { stage } userErrors { code message } }
        }`,
        { variantId },
      );
      expect(order.data?.orderCreate.order).toEqual({ stage: 'NEEDS_CONFIRMATION' });
    }
    const home = await gql(tokens.owner, HOME);
    expect(home.data?.home.toConfirm).toEqual({
      count: 2,
      total: { amount: '4998.00', currencyCode: 'PKR' },
    });

    // How today has gone, worked out when asked for (ADR-121).
    const today = await gql(
      tokens.owner,
      `{ home { today {
          since sales { count total { amount } } salesYesterday { count }
          delivered { count } returnedToOrigin { count }
        } } }`,
    );
    expect(today.data?.home.today).toMatchObject({
      sales: { count: 2, total: { amount: '4998.00' } },
      salesYesterday: { count: 0 },
      delivered: { count: 0 },
      returnedToOrigin: { count: 0 },
    });
    const since = Date.parse(today.data?.home.today.since);
    expect(Date.now() - since).toBeGreaterThanOrEqual(0);
    expect(Date.now() - since).toBeLessThan(86_400_000);

    const denied = await gql(tokens.products, HOME);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('says what couriers owe on delivered orders, by courier and by age', async () => {
    const RECEIVABLES = `{
      codReceivables {
        owed { count amount { amount currencyCode } }
        ages { fromDays toDays count amount { amount } }
        onTheWay { count amount { amount } }
        couriers { courier owed { count amount { amount } } ages { count } oldestDeliveredAt }
      }
    }`;
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "5,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const placed = await gql(
      tokens.owner,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" }
        }) { order { id } userErrors { code message } }
      }`,
      { variantId: created.data?.productCreate.product.variants[0].id },
    );
    const id = placed.data?.orderCreate.order.id;
    await gql(
      tokens.owner,
      `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
      {
        id,
      },
    );
    const fulfilled = await gql(
      tokens.owner,
      `mutation ($id: ID!) {
        orderFulfill(id: $id, input: { trackingInfo: { company: "Leopards", number: "LE123456" } }) {
          fulfillment { id } userErrors { code message }
        }
      }`,
      { id },
    );
    const onItsWay = await gql(tokens.owner, RECEIVABLES);
    expect(onItsWay.data?.codReceivables).toMatchObject({
      owed: { count: 0, amount: { amount: '0.00', currencyCode: 'PKR' } },
      onTheWay: { count: 1, amount: { amount: '5000.00' } },
      couriers: [],
    });
    await gql(
      tokens.owner,
      `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { userErrors { code } } }`,
      { id: fulfilled.data?.orderFulfill.fulfillment.id },
    );
    const owed = (await gql(tokens.owner, RECEIVABLES)).data?.codReceivables;
    expect(owed).toMatchObject({
      owed: { count: 1, amount: { amount: '5000.00' } },
      ages: [
        { fromDays: 0, toDays: 7, count: 1, amount: { amount: '5000.00' } },
        { fromDays: 8, toDays: 14, count: 0 },
        { fromDays: 15, toDays: 30, count: 0 },
        { fromDays: 31, toDays: null, count: 0 },
      ],
      onTheWay: { count: 0 },
      couriers: [
        {
          courier: 'Leopards',
          owed: { count: 1, amount: { amount: '5000.00' } },
          ages: [{ count: 1 }, { count: 0 }, { count: 0 }, { count: 0 }],
        },
      ],
    });
    expect(Date.parse(owed.couriers[0].oldestDeliveredAt)).toBeGreaterThan(Date.now() - 60_000);

    // Paid: nothing owed.
    await gql(
      tokens.owner,
      `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { userErrors { code } } }`,
      {
        id,
      },
    );
    expect((await gql(tokens.owner, RECEIVABLES)).data?.codReceivables.owed.count).toBe(0);
    const denied = await gql(tokens.products, RECEIVABLES);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});

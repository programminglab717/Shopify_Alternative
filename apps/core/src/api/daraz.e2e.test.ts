import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { DarazClient } from '@hatti/orders/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ACCOUNT = `account sellerId locationId syncPrices lastError leftOut { darazOrderId error }`;

/** Daraz's Open Platform, faked: its orders as the test sets them, what it was given kept. */
function fakeDaraz() {
  const state = {
    orders: [] as Record<string, unknown>[],
    items: {} as Record<string, { sku: string; paid_price: string }[]>,
    pushed: [] as string[],
  };
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/auth/token/create')) {
      return answer({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 86_400,
        refresh_expires_in: 2_592_000,
        account: 'zari@daraz.pk',
        country_user_info: [{ seller_id: '7788' }],
      });
    }
    if (path.endsWith('/orders/get')) return answer({ code: '0', data: { orders: state.orders } });
    if (path.endsWith('/orders/items/get')) {
      const ids = (new URL(url).searchParams.get('order_ids') ?? '[]').slice(1, -1).split(',');
      return answer({
        code: '0',
        data: ids.map((id) => ({ order_id: id, order_items: state.items[id] ?? [] })),
      });
    }
    if (path.endsWith('/product/price_quantity/update')) {
      state.pushed.push(new URLSearchParams(String(init?.body)).get('payload') ?? '');
      return answer({ code: '0' });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return {
    state,
    client: new DarazClient({
      appKey: '501234',
      appSecret: 'the-app-secret-of-daraz',
      apiUrl: 'https://api.daraz.example/rest',
      authUrl: 'https://auth.daraz.example/rest',
      authorizeUrl: 'https://api.daraz.example/oauth/authorize',
      fetch,
    }),
  };
}

const order = (id: string, status: string) => ({
  order_id: id,
  statuses: [status],
  created_at: '2026-10-28 10:00:00 +0500',
  address_shipping: {
    first_name: 'Ayesha',
    last_name: 'Khan',
    phone: '923001234567',
    address1: 'House 12, Street 4',
    city: 'Lahore',
  },
});

describe.skipIf(!server)("A shop's Daraz account, kept in step (CH-06, ADR-875)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';
  let location = '';
  const daraz = fakeDaraz();

  async function data(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    const body = response.json<{ data?: Json; errors?: Json[] }>();
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    const generated = generateAccessToken();
    token = generated.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [
        shop,
        generated.hash,
        generated.hint,
        ['write_products', 'write_inventory', 'write_locations', 'write_orders', 'write_settings'],
      ],
    );
    api = await startTestApi(testDb, { daraz: daraz.client });
    app = api.app;
    location = (await data('{ location { id } }')).id;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('connects, brings orders in once, follows cancellations, and gives Daraz the stock', async () => {
    expect(await data('{ daraz { available account { account } } }')).toEqual({
      available: true,
      account: null,
    });
    const url = new URL(
      await data(`{ darazConnectUrl(redirectUri: "https://admin.hatti.pk/daraz/callback") }`),
    );
    expect(url.origin + url.pathname).toBe('https://api.daraz.example/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('501234');
    const state = url.searchParams.get('state')!;
    const CONNECT = `mutation ($code: String!, $state: String!) {
      darazConnect(code: $code, state: $state) { account { ${ACCOUNT} } userErrors { field message } } }`;
    // Only with the state its own link carried.
    expect((await data(CONNECT, { code: 'c', state: 'forged' })).userErrors[0].field).toEqual([
      'state',
    ]);
    const connected = await data(CONNECT, { code: 'the-code', state });
    expect(connected.account).toEqual({
      account: 'zari@daraz.pk',
      sellerId: '7788',
      locationId: location,
      syncPrices: false,
      lastError: null,
      leftOut: [],
    });

    const created = await data(
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id variants { id inventoryItem { id } } } } }`,
      {
        input: {
          title: 'Lawn Suit',
          status: 'ACTIVE',
          variants: [{ price: '3,000', sku: 'LS-M' }],
        },
      },
    );
    await data(
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } } }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            {
              inventoryItemId: created.product.variants[0].inventoryItem.id,
              locationId: location,
              quantity: 5,
            },
          ],
        },
      },
    );
    // A new order of two suits, one of a SKU the shop has none of, one long delivered.
    daraz.state.orders = [
      order('9001', 'pending'),
      order('9002', 'pending'),
      order('9003', 'delivered'),
    ];
    daraz.state.items = {
      '9001': [
        { sku: 'LS-M', paid_price: '2900.00' },
        { sku: 'LS-M', paid_price: '2900.00' },
      ],
      '9002': [{ sku: 'NOT-HERE', paid_price: '100.00' }],
    };
    const SYNC = 'mutation { darazSync { imported cancelled leftOut pushed } }';
    expect(await data(SYNC)).toEqual({ imported: 1, cancelled: 0, leftOut: 1, pushed: 1 });
    expect(daraz.state.pushed.at(-1)).toContain(
      '<Sku><SellerSku>LS-M</SellerSku><Quantity>3</Quantity></Sku>',
    );
    const orders = await data(`{ orders(first: 5, query: "tag:daraz") {
      nodes { id source financialStatus tags totalPrice { amount } } } }`);
    expect(orders.nodes).toEqual([
      {
        id: expect.any(String),
        source: 'MARKETPLACE',
        financialStatus: 'PAID',
        tags: ['daraz'],
        totalPrice: { amount: '5800.00' },
      },
    ]);
    expect(
      (await data(`{ daraz { account { leftOut { darazOrderId error } } } }`)).account.leftOut,
    ).toEqual([
      { darazOrderId: '9002', error: 'The shop has no active product with SKU NOT-HERE' },
    ]);

    // Read again, nothing comes in twice, and nothing unchanged is given Daraz again.
    expect(await data(SYNC)).toEqual({ imported: 0, cancelled: 0, leftOut: 0, pushed: 0 });
    // Cancelled on Daraz: cancelled here, the suits back for Daraz to sell.
    daraz.state.orders = [order('9001', 'canceled')];
    expect(await data(SYNC)).toEqual({ imported: 0, cancelled: 1, leftOut: 0, pushed: 1 });
    expect(daraz.state.pushed.at(-1)).toContain('<Quantity>5</Quantity>');
    const cancelled = await data(`query ($id: ID!) { order(id: $id) { status } }`, {
      id: orders.nodes[0].id,
    });
    expect(cancelled.status).toBe('CANCELLED');

    // With prices, Daraz is given them too.
    await data(`mutation { darazAccountUpdate(syncPrices: true) { account { syncPrices } } }`);
    daraz.state.orders = [];
    await data(SYNC);
    expect(daraz.state.pushed.at(-1)).toContain('<Quantity>5</Quantity><Price>3000.00</Price>');
    expect(await data('mutation { darazDisconnect }')).toBe(true);
    expect((await data('{ daraz { account { account } } }')).account).toBeNull();
  });
});

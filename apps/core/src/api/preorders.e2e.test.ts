import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { pakistanDay } from '@hatti/inventory/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SET = `mutation ($productId: ID!, $shipsOn: String) {
  productPreorderSet(productId: $productId, shipsOn: $shipsOn) {
    preorder { productId shipsOn } userErrors { field code }
  }
}`;

const ORDER = 'id lineItems { id title quantity preorderShipsOn }';

describe.skipIf(!server)('Admin GraphQL API: pre-orders (CAT-14, ADR-403)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { all: '', orders: '' };
  let location = '';

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

  /** A product with one variant and `quantity` of it in stock: its ID and the variant's. */
  async function stocked(title: string, quantity: number): Promise<[string, string]> {
    const created = await data(
      tokens.all,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) {
          product { id variants { id inventoryItem { id } } }
        }
      }`,
      { input: { title, status: 'ACTIVE', variants: [{ price: '2,000' }] } },
    );
    const variant = created.product.variants[0];
    await data(
      tokens.all,
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            { inventoryItemId: variant.inventoryItem.id, locationId: location, quantity },
          ],
        },
      },
    );
    return [created.product.id, variant.id];
  }

  function place(variantId: string, quantity: number) {
    return gql(
      tokens.all,
      `mutation ($input: OrderCreateInput!) {
        orderCreate(input: $input) { order { ${ORDER} } userErrors { field code } }
      }`,
      {
        input: {
          lineItems: [{ variantId, quantity }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300-1234567',
            address1: 'House 12, Street 4, Block 5',
            city: 'khi',
          },
        },
      },
    );
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.all = await issueToken([
      'write_products',
      'write_inventory',
      'write_locations',
      'write_orders',
    ]);
    tokens.orders = await issueToken(['write_orders']);
    api = await startTestApi(testDb);
    app = api.app;
    location = (await gql(tokens.all, '{ location { id } }')).data.location.id;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sells a product on pre-order past its stock, its lines keeping the day it ships by', async () => {
    const [kurta, kurtaVariant] = await stocked('Eid kurta', 1);
    const [, dupatta] = await stocked('Dupatta', 5);
    const day = pakistanDay(new Date(), 30);
    const later = pakistanDay(new Date(), 45);

    expect(await data(tokens.all, SET, { productId: kurta, shipsOn: day })).toEqual({
      preorder: { productId: kurta, shipsOn: day },
      userErrors: [],
    });
    const read = await data(
      tokens.all,
      'query ($id: ID!) { product(id: $id) { preorder { shipsOn } } }',
      { id: kurta },
    );
    expect(read).toEqual({ preorder: { shipsOn: day } });

    // Three of one in stock: on pre-order, it sells.
    const placed = await place(kurtaVariant, 3);
    expect(placed.errors).toBeUndefined();
    const order = placed.data.orderCreate.order;
    expect(order.lineItems).toMatchObject([
      { title: 'Eid kurta', quantity: 3, preorderShipsOn: day },
    ]);

    // The customer's order page says so, in English and Urdu.
    const link = await data(
      tokens.all,
      'mutation ($id: ID!) { orderLinkCreate(id: $id) { url userErrors { code } } }',
      { id: order.id },
    );
    const page = await app.inject({ method: 'GET', url: new URL(link.url).pathname });
    const words = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${day}T00:00:00Z`));
    expect(page.body).toContain(`Pre-order: ships by ${words}`);
    expect(page.body).toContain(`پیشگی آرڈر: ${words} تک روانہ ہوگا`);

    // Its day moved on, the line sold keeps the day it was sold with; a dupatta added has none.
    await data(tokens.all, SET, { productId: kurta, shipsOn: later });
    const edited = await data(
      tokens.all,
      `mutation ($id: ID!, $input: OrderEditLineItemsInput!) {
        orderEditLineItems(id: $id, input: $input) { order { ${ORDER} } userErrors { field code } }
      }`,
      { id: order.id, input: { addVariants: [{ variantId: dupatta, quantity: 1 }] } },
    );
    expect(edited.userErrors).toEqual([]);
    expect(edited.order.lineItems).toMatchObject([
      { title: 'Eid kurta', preorderShipsOn: day },
      { title: 'Dupatta', preorderShipsOn: null },
    ]);

    // Off pre-order, it sells only as its stock allows: none is left.
    expect(await data(tokens.all, SET, { productId: kurta, shipsOn: null })).toEqual({
      preorder: null,
      userErrors: [],
    });
    expect(
      (
        await data(tokens.all, 'query ($id: ID!) { product(id: $id) { preorder { shipsOn } } }', {
          id: kurta,
        })
      ).preorder,
    ).toBeNull();
    const refused = await place(kurtaVariant, 1);
    expect(refused.data.orderCreate.userErrors[0].code).toBe('OUT_OF_STOCK');

    const { rows } = await admin.query(
      `SELECT payload->>'shipsOn' AS ships_on FROM platform.outbox_events
        WHERE event_type = 'product_preorder.updated' ORDER BY occurred_at`,
    );
    expect(rows.map((row) => row.ships_on)).toEqual([day, later, null]);
  });

  it('refuses a day gone by, and those who may not change products', async () => {
    const [kurta] = await stocked('Lawn kurta', 1);
    expect(
      (await data(tokens.all, SET, { productId: kurta, shipsOn: '2020-01-01' })).userErrors,
    ).toEqual([{ field: ['shipsOn'], code: 'INVALID' }]);
    const denied = await gql(tokens.orders, SET, { productId: kurta, shipsOn: null });
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');
  });
});

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import {
  cartPath,
  checkoutsPath,
  type CartChangeResponse,
  type CheckoutStartResponse,
} from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const OPTIONS = `wrap { variantId productTitle variantTitle price { amount } forSale } messages`;

const UPDATE = `mutation ($input: CheckoutGiftOptionsInput!) {
  checkoutGiftOptionsUpdate(input: $input) {
    checkoutGiftOptions { ${OPTIONS} } userErrors { field code }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API and checkout: gift options (CHK-16, ADR-413)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { all: '', orders: '' };

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

  /** An active product of one variant at `price`: its variant's public ID. */
  async function variant(title: string, price: string): Promise<string> {
    const created = await data(
      tokens.all,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { variants { id } } }
      }`,
      { input: { title, status: 'ACTIVE', variants: [{ price }] } },
    );
    return created.product.variants[0].id;
  }

  const post = (url: string, form: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.all = await issueToken([
      'write_products',
      'read_settings',
      'write_settings',
      'write_orders',
    ]);
    tokens.orders = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sets the gift wrap and messages, which the checkout page offers and the order keeps', async () => {
    expect(await data(tokens.all, `{ checkoutGiftOptions { ${OPTIONS} } }`)).toEqual({
      wrap: null,
      messages: false,
    });
    const wrap = await variant('Gift wrap', '150');
    const kurta = await variant('Kurta', '2,000');
    expect(
      await data(tokens.all, UPDATE, { input: { wrapVariantId: wrap, messages: true } }),
    ).toEqual({
      checkoutGiftOptions: {
        wrap: {
          variantId: wrap,
          productTitle: 'Gift wrap',
          variantTitle: 'Default Title',
          price: { amount: '150.00' },
          forSale: true,
        },
        messages: true,
      },
      userErrors: [],
    });

    // A shopper's cart, its checkout, the wrap added on its page and a message with the order.
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shop, 'add'),
      headers: { authorization: `Bearer ${TEST_STOREFRONT_KEY}` },
      payload: { items: [{ variantId: fromPublicId(kurta, 'variant'), quantity: 1 }] },
    });
    const started = await app.inject({
      method: 'POST',
      url: checkoutsPath(shop),
      headers: {
        authorization: `Bearer ${TEST_STOREFRONT_KEY}`,
        'x-hatti-cart': (added.json() as CartChangeResponse).token!,
      },
    });
    const path = (started.json() as CheckoutStartResponse).path;
    const wrapped = await post(path, { action: 'gift_wrap' });
    expect(wrapped.statusCode).toBe(200);
    expect(wrapped.body).toContain('Your order is gift-wrapped');
    const shown = /name="shown" value="([\w-]{22})"/.exec(wrapped.body)![1]!;
    const placed = await post(path, {
      shown,
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      city: 'Lahore',
      address1: 'House 12, Street 4',
      gift_message: 'Eid Mubarak!',
    });
    expect(placed.statusCode).toBe(303);
    const read = await data(
      tokens.orders,
      '{ orders(first: 1) { nodes { giftMessage lineItems { title } } } }',
    );
    expect(read.nodes).toEqual([
      { giftMessage: 'Eid Mubarak!', lineItems: [{ title: 'Gift wrap' }, { title: 'Kurta' }] },
    ]);

    // Staff take one with a message too, of at most 250 characters.
    const order = (giftMessage: string) =>
      data(
        tokens.all,
        `mutation ($input: OrderCreateInput!) {
          orderCreate(input: $input) { order { giftMessage } userErrors { field code } }
        }`,
        {
          input: {
            lineItems: [{ variantId: kurta, quantity: 1 }],
            shippingAddress: {
              name: 'Ayesha Khan',
              phone: '0300-1234567',
              address1: 'House 12, Street 4, Block 5',
              city: 'khi',
            },
            giftMessage,
          },
        },
      );
    expect(await order('For Nani')).toEqual({ order: { giftMessage: 'For Nani' }, userErrors: [] });
    expect((await order('x'.repeat(251))).userErrors).toEqual([
      { field: ['input', 'giftMessage'], code: 'TOO_LONG' },
    ]);
  });

  it('refuses a variant not the shop’s, and asks the settings scopes', async () => {
    expect(
      (
        await data(tokens.all, UPDATE, {
          input: { wrapVariantId: toPublicId('variant', newId()), messages: false },
        })
      ).userErrors,
    ).toEqual([{ field: ['input', 'wrapVariantId'], code: 'NOT_FOUND' }]);
    const bad = await gql(tokens.all, UPDATE, {
      input: { wrapVariantId: 'nope', messages: false },
    });
    expect(bad.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
    const denied = await gql(tokens.orders, `{ checkoutGiftOptions { messages } }`);
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');
  });
});

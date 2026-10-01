import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import {
  StorefrontApiClient,
  cartPath,
  checkoutsPath,
  type CartChangeResponse,
  type CheckoutPageResponse,
  type CheckoutStartResponse,
} from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

const FORM = {
  name: 'Ayesha Khan',
  phone: '0300 1234567',
  city: 'Lahore',
  address1: 'House 12, Street 4, Gulberg III',
  address2: '',
  province: '',
};

describe.skipIf(!server)('Checkouts', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  let kurta = '';
  let adminToken = '';

  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  /** A cart of two kurtas in shop A: its token. */
  async function cart(): Promise<string> {
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shopA, 'add'),
      headers: asStorefront,
      payload: { items: [{ variantId: kurta, quantity: 2 }] },
    });
    return (added.json() as CartChangeResponse).token!;
  }

  async function start(shopId: string, token?: string, headers = asStorefront) {
    return app.inject({
      method: 'POST',
      url: checkoutsPath(shopId),
      headers: { ...headers, ...(token ? { 'x-hatti-cart': token } : {}) },
    });
  }

  /** A new checkout of a new cart: its page's path. */
  async function checkout(): Promise<string> {
    return ((await start(shopA, await cart())).json() as CheckoutStartResponse).path;
  }

  /** The digest of what a page showed, from its form. */
  const shownIn = (html: string) => /name="shown" value="([\w-]{22})"/.exec(html)![1]!;

  const post = (url: string, form: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });

  async function orders(): Promise<{ source: string; payment_method: string; total: string }[]> {
    const { rows } = await admin.query(
      'SELECT source, payment_method, total::text FROM orders.orders ORDER BY number',
    );
    return rows;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shopA,
      shopB,
    ]);
    const { token, hash, hint } = generateAccessToken();
    adminToken = token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopA, hash, hint, ['write_products', 'read_orders']],
    );
    api = await startTestApi(testDb);
    app = api.app;
    const created = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: {
        query: `mutation {
          productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
            product { variants { id } }
          }
        }`,
      },
    });
    kurta = fromPublicId(created.json().data.productCreate.product.variants[0].id, 'variant');
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM orders.orders; DELETE FROM checkout.checkouts');
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('starts for storefronts with the key, for carts with something to order', async () => {
    const token = await cart();
    expect((await start(shopA, token, {} as typeof asStorefront)).statusCode).toBe(401);
    expect((await start('not-a-shop', token)).statusCode).toBe(404);
    const none = await start(shopA);
    expect([none.statusCode, none.json()]).toEqual([422, { error: { code: 'EMPTY' } }]);
    expect((await start(shopB, token)).json()).toEqual({ error: { code: 'EMPTY' } });

    const started = await start(shopA, token);
    expect(started.statusCode).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const { path, url } = started.json() as CheckoutStartResponse;
    expect(path).toMatch(/^\/checkouts\/[\w-]{22}$/);
    expect(url).toBe(`http://localhost:4000${path}`);
  });

  it('shows the checkout at its address, and places the order its form posts once', async () => {
    const path = await checkout();
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    });
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.body).toContain('Checkout · Zari');
    expect(page.body).toContain('2 ×');

    const wrong = await post(path, { ...FORM, phone: '123', shown: shownIn(page.body) });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.body).toContain('Enter a Pakistani mobile number');
    expect(await orders()).toEqual([]);

    const placed = await post(path, { ...FORM, shown: shownIn(wrong.body) });
    expect(placed.statusCode).toBe(303);
    expect(placed.headers.location).toBe(path.split('/').at(-1));
    expect(await orders()).toEqual([
      { source: 'online_store', payment_method: 'cash_on_delivery', total: '400000' },
    ]);
    const listed = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': adminToken },
      payload: { query: '{ orders(first: 5) { nodes { name source } } }' },
    });
    expect(listed.json()).toEqual({
      data: { orders: { nodes: [{ name: '#1001', source: 'ONLINE_STORE' }] } },
    });
    const thanks = await app.inject({ method: 'GET', url: path });
    expect(thanks.body).toContain('Your order #1001 is placed.');
    expect(thanks.body).toContain('You pay Rs 4,000 when it arrives.');

    // Posting again, as a double tap would, places nothing more.
    expect((await post(path, { ...FORM, shown: shownIn(page.body) })).statusCode).toBe(303);
    expect(await orders()).toHaveLength(1);

    const unknown = await app.inject({ method: 'GET', url: `/checkouts/${'x'.repeat(22)}` });
    expect(unknown.statusCode).toBe(404);
  });

  it("gives storefronts the page to send on the shop's address, for its own checkouts", async () => {
    const secret = (await checkout()).split('/').at(-1)!;
    const read = (shopId: string, headers: Record<string, string> = asStorefront) =>
      app.inject({ method: 'GET', url: checkoutsPath(shopId, secret), headers });
    expect((await read(shopA, {})).statusCode).toBe(401);
    const response = await read(shopA);
    expect(response.statusCode).toBe(200);
    const page = response.json() as Extract<CheckoutPageResponse, { placed: false }>;
    expect(page).toMatchObject({
      placed: false,
      status: 200,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
    });
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.html).toContain('Checkout · Zari');
    expect((await read(shopB)).json()).toMatchObject({ placed: false, status: 404 });

    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    const stale = await client.checkoutPage(shopA, secret, { ...FORM, shown: 'x'.repeat(22) });
    expect(stale).toMatchObject({ placed: false, status: 409 });
    const shown = shownIn(page.html);
    expect(await client.checkoutPage(shopA, secret, { ...FORM, shown })).toEqual({ placed: true });
    expect(await orders()).toHaveLength(1);
    expect(await client.startCheckout(shopA, await cart())).toMatchObject({
      ok: true,
      path: expect.stringMatching(/^\/checkouts\//),
    });
  });

  it('keeps what the shopper agreed to with the order, which the Admin API shows as it was', async () => {
    const { token: legal, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'legal', $2, $3, $4)`,
      [shopA, hash, hint, ['write_legal_policies', 'read_orders']],
    );
    const gql = async (query: string, variables?: Record<string, unknown>) =>
      (
        await app.inject({
          method: 'POST',
          url: ADMIN_GRAPHQL_PATH,
          headers: { 'x-hatti-access-token': legal },
          payload: { query, variables },
        })
      ).json();
    const refundPolicy = (body: string) =>
      gql(
        `mutation ($policy: ShopPolicyInput!) {
          shopPolicyUpdate(shopPolicy: $policy) { userErrors { code } }
        }`,
        { policy: { type: 'REFUND_POLICY', body } },
      );
    await refundPolicy('<p>7 days.</p>');

    const secret = (await checkout()).split('/').at(-1)!;
    const shown = await app.inject({
      method: 'GET',
      url: checkoutsPath(shopA, secret),
      headers: asStorefront,
    });
    const page = shown.json() as Extract<CheckoutPageResponse, { placed: false }>;
    expect(page.html).toContain("By placing your order, you agree to the shop's");
    const placed = await app.inject({
      method: 'POST',
      url: checkoutsPath(shopA, secret),
      headers: {
        ...asStorefront,
        'x-hatti-client-ip': '203.0.113.7',
        'x-hatti-client-user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      payload: { ...FORM, shown: shownIn(page.html) },
    });
    expect(placed.json()).toEqual({ placed: true });

    // The policy changes after the order: the order shows what its customer agreed to.
    await refundPolicy('<p>14 days.</p>');
    const { data } = await gql(`{
      orders(first: 1) {
        nodes { agreement { agreedAt ip userAgent policies { id type title body } } }
      }
    }`);
    expect(data.orders.nodes[0].agreement).toEqual({
      agreedAt: expect.any(String),
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      policies: [
        {
          id: expect.stringMatching(/^plv_[0-9A-Za-z]+$/),
          type: 'REFUND_POLICY',
          title: 'Refund policy',
          body: '<p>7 days.</p>',
        },
      ],
    });
  });
});

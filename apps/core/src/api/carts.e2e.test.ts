import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import { StorefrontApiClient, cartPath, type CartChangeResponse } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Storefront API: carts', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  /** The variants of a product in shop A, as the storefront's documents name them. */
  let sizes: string[] = [];

  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  async function post(shopId: string, action: string, payload: unknown, token?: string) {
    return app.inject({
      method: 'POST',
      url: `${cartPath(shopId)}/${action}`,
      headers: { ...asStorefront, ...(token ? { 'x-hatti-cart': token } : {}) },
      payload: payload as Record<string, unknown>,
    });
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
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopA, hash, hint, ['write_products']],
    );
    api = await startTestApi(testDb);
    app = api.app;
    const created = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: {
        query: `mutation {
          productCreate(input: {
            title: "Lawn 3-piece", status: ACTIVE,
            options: [{ name: "Size", values: ["S", "M"] }],
            variants: [{ optionValues: ["S"], price: "4,500" }, { optionValues: ["M"], price: "4,500" }]
          }) { product { variants { id } } userErrors { message } }
        }`,
      },
    });
    const variants = created.json().data.productCreate.product.variants as { id: string }[];
    sizes = variants.map((variant) => fromPublicId(variant.id, 'variant'));
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('answers storefronts with the key, and no one else', async () => {
    const read = (headers: Record<string, string>, shopId = shopA) =>
      app.inject({ method: 'GET', url: cartPath(shopId), headers });
    expect((await read({})).statusCode).toBe(401);
    expect((await read({ authorization: 'Bearer not-the-storefront-key' })).statusCode).toBe(401);
    // Customers' and staff's credentials are not the storefront's either.
    expect((await read({ 'x-hatti-access-token': 'shpat_x' })).statusCode).toBe(401);
    const empty = await read(asStorefront);
    expect([empty.statusCode, empty.json()]).toEqual([200, { cart: null }]);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect((await read(asStorefront, 'not-a-shop')).statusCode).toBe(404);
    expect((await post(shopA, 'empty', {})).statusCode).toBe(404);
  });

  it("keeps a shopper's cart as the storefront changes it", async () => {
    const [small, medium] = sizes;
    const added = await post(shopA, 'add', { items: [{ variantId: small, quantity: 2 }] });
    expect(added.statusCode).toBe(200);
    const body = added.json() as CartChangeResponse;
    expect(body.token).toMatch(/^[\w-]{22}$/);
    expect(
      body.cart.items.map((item) => [item.variantTitle, item.quantity, item.linePrice]),
    ).toEqual([['S', 2, 900_000]]);

    const changed = await post(
      shopA,
      'change',
      { line: { key: body.added[0] }, quantity: 3 },
      body.token!,
    );
    expect((changed.json() as CartChangeResponse).cart.itemCount).toBe(3);
    const read = await app.inject({
      method: 'GET',
      url: cartPath(shopA),
      headers: { ...asStorefront, 'x-hatti-cart': body.token! },
    });
    expect(read.json().cart.items[0].quantity).toBe(3);

    // Refused with why, the cart as it was.
    const unknown = await post(shopA, 'add', { items: [{ variantId: newId() }] }, body.token!);
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    const invalid = await post(shopA, 'update', { note: 42 }, body.token!);
    expect([invalid.statusCode, invalid.json()]).toEqual([
      422,
      { error: { code: 'INVALID', message: 'note must be text' } },
    ]);
    // Another shop's storefront finds nothing by the secret, and cannot sell shop A's variants.
    const elsewhere = await post(shopB, 'add', { items: [{ variantId: medium }] }, body.token!);
    expect(elsewhere.json()).toEqual({ error: { code: 'NOT_FOUND', variantId: medium } });
  });

  it('is what StorefrontApiClient speaks', async () => {
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    const added = await client.act(shopA, null, 'add', { items: [{ variantId: sizes[1]! }] });
    expect(added).toMatchObject({ ok: true, cart: { itemCount: 1 } });
    const token = added.ok ? added.token : null;
    expect((await client.read(shopA, token))!.items[0]!.variantTitle).toBe('M');
    expect(await client.act(shopA, token, 'change', { line: { index: 2 }, quantity: 1 })).toEqual({
      ok: false,
      error: { code: 'LINE_NOT_FOUND' },
    });
    const wrongKey = new StorefrontApiClient({ baseUrl: await app.getUrl(), key: 'x'.repeat(32) });
    await expect(wrongKey.read(shopA, token)).rejects.toThrow('answered 401');
  });
});

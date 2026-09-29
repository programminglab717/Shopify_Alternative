import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { fingerprintOf } from './idempotency.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SCOPES = ['write_products', 'write_inventory', 'write_locations', 'write_orders'];

const ORDER_CREATE = `
  mutation ($input: OrderCreateInput!) {
    orderCreate(input: $input) { order { id name } userErrors { field code message } }
  }`;

describe.skipIf(!server)('Admin GraphQL API: idempotency keys', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const [shopA, shopB] = [newId(), newId()];
  const tokens = { a: '', aOther: '', b: '' };
  let tokenIdA = '';
  let variantId = '';

  async function issueToken(shopId: string): Promise<{ token: string; id: string }> {
    const { token, hash, hint } = generateAccessToken();
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4) RETURNING id`,
      [shopId, hash, hint, SCOPES],
    );
    return { token, id: rows[0]!.id };
  }

  /** Posts a GraphQL request, with `key` as its Idempotency-Key if given. */
  const post = (token: string, body: Record<string, unknown>, key?: string) =>
    api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        'x-hatti-access-token': token,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload: body,
    });

  const orderBody = (quantity = 1) => ({
    query: ORDER_CREATE,
    variables: {
      input: {
        lineItems: [{ variantId, quantity }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300 1234567',
          address1: 'House 12, Street 4',
          city: 'Karachi',
        },
      },
    },
  });

  const ordersOfShopA = async () =>
    (
      await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM orders.orders WHERE shop_id = $1',
        [shopA],
      )
    ).rows[0]!.count;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    const a = await issueToken(shopA);
    [tokens.a, tokenIdA] = [a.token, a.id];
    tokens.aOther = (await issueToken(shopA)).token;
    tokens.b = (await issueToken(shopB)).token;
    api = await startTestApi(testDb);

    // A kurta with plenty of stock. Neither mutation needs a key.
    const created = (
      await post(tokens.a, {
        query: `mutation {
          productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
            product { variants { id inventoryItem { id } } }
          }
          }`,
      })
    ).json<Json>().data.productCreate.product.variants[0];
    variantId = created.id;
    const location = (await post(tokens.a, { query: '{ location { id } }' })).json<Json>().data
      .location.id;
    const counted = await post(tokens.a, {
      query: `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } }
      }`,
      variables: {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            { inventoryItemId: created.inventoryItem.id, locationId: location, quantity: 50 },
          ],
        },
      },
    });
    expect(counted.json<Json>().data.inventorySetQuantities.userErrors).toEqual([]);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM platform.idempotency_keys');
  });

  it('refuses mutations that must not run twice without a key', async () => {
    const before = await ordersOfShopA();
    const refused = await post(tokens.a, orderBody());
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({
      errors: [
        {
          message:
            'orderCreate must not run twice, so send an Idempotency-Key header: a new value, ' +
            'such as a UUID, for each request, and the same one again when you retry it',
          extensions: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
        },
      ],
    });
    // An alias or a fragment does not get round it.
    const hidden = await post(tokens.a, {
      query: `mutation ($input: OrderCreateInput!) { ...Place }
        fragment Place on Mutation { placed: orderCreate(input: $input) { order { id } } }`,
      variables: orderBody().variables,
    });
    expect(hidden.json<Json>().errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await ordersOfShopA()).toBe(before);

    for (const key of ['', 'ключ', 'x'.repeat(256), 'two words']) {
      const invalid = await post(tokens.a, orderBody(), key);
      expect(invalid.statusCode, key).toBe(400);
      expect(invalid.json<Json>().errors[0].extensions.code, key).toBe('IDEMPOTENCY_KEY_INVALID');
    }

    // Mutations that are safe to repeat, and queries, need none.
    const tagged = await post(tokens.a, {
      query: `mutation { productCreate(input: { title: "Shawl" }) { product { title } } }`,
    });
    expect(tagged.json()).toEqual({ data: { productCreate: { product: { title: 'Shawl' } } } });
    expect((await post(tokens.a, { query: '{ shop { name } }' }, 'ignored')).statusCode).toBe(200);
  });

  it('answers a retry with the first answer, and places the order once', async () => {
    const before = await ordersOfShopA();
    const key = randomUUID();
    const first = await post(tokens.a, orderBody(), key);
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const order = first.json<Json>().data.orderCreate.order;
    expect(order.id).toMatch(/^ord_/);

    const retry = await post(tokens.a, orderBody(), key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toBe(first.body);
    expect(await ordersOfShopA()).toBe(before + 1);

    // The same key with another request is a mistake.
    const other = await post(tokens.a, orderBody(2), key);
    expect(other.statusCode).toBe(422);
    expect(other.json<Json>().errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Keys are each caller's own: another app of the shop, or another shop, starts afresh.
    const otherApp = await post(tokens.aOther, orderBody(), key);
    expect(otherApp.headers['idempotent-replayed']).toBeUndefined();
    expect(otherApp.json<Json>().data.orderCreate.order.id).not.toBe(order.id);
    const otherShop = await post(tokens.b, orderBody(), key);
    expect(otherShop.json<Json>().data.orderCreate).toMatchObject({
      order: null,
      userErrors: [{ code: 'NOT_FOUND' }],
    });
    expect(await ordersOfShopA()).toBe(before + 2);

    // User errors are answers too, and come back as they were.
    const empty = {
      ...orderBody(),
      variables: { input: { ...orderBody().variables.input, lineItems: [] } },
    };
    const refused = await post(tokens.a, empty, 'refused-once');
    const replayed = await post(tokens.a, empty, 'refused-once');
    expect(replayed.body).toBe(refused.body);
    expect(replayed.json<Json>().data.orderCreate.userErrors[0].code).toBe('BLANK');
  });

  it('holds a key while its first request runs, and frees it if that request dies', async () => {
    const before = await ordersOfShopA();
    const body = orderBody();
    const hold = (lockedUntil: string) =>
      admin.query(
        `INSERT INTO platform.idempotency_keys
           (shop_id, actor_id, key, fingerprint, locked_until, expires_at)
         VALUES ($1, $2, 'running', $3, now() + $4::interval, now() + interval '1 day')
         ON CONFLICT (shop_id, actor_id, key) DO UPDATE SET locked_until = EXCLUDED.locked_until`,
        [shopA, tokenIdA, fingerprintOf(body), lockedUntil],
      );
    await hold('1 minute');
    const waiting = await post(tokens.a, body, 'running');
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json<Json>().errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(await ordersOfShopA()).toBe(before);

    await hold('-1 second');
    const takenOver = await post(tokens.a, body, 'running');
    expect(takenOver.json<Json>().data.orderCreate.order.id).toMatch(/^ord_/);
    expect(await ordersOfShopA()).toBe(before + 1);
    const { rows } = await admin.query<{ status_code: number; response: string }>(
      `SELECT status_code, response FROM platform.idempotency_keys WHERE key = 'running'`,
    );
    expect(rows).toEqual([{ status_code: 200, response: takenOver.body }]);
  });

  it('forgets answers after a day', async () => {
    const before = await ordersOfShopA();
    for (const key of ['old', 'stale']) {
      await admin.query(
        `INSERT INTO platform.idempotency_keys
           (shop_id, actor_id, key, fingerprint, status_code, response, locked_until, created_at,
            expires_at)
         VALUES ($1, $2, $3, $4, 200, '{"data":null}', now() - interval '25 hours',
                 now() - interval '25 hours', now() - interval '1 hour')`,
        [shopA, tokenIdA, key, Buffer.alloc(32)],
      );
    }
    // A key whose answer expired is new again, whatever it was used for.
    const fresh = await post(tokens.a, orderBody(), 'old');
    expect(fresh.headers['idempotent-replayed']).toBeUndefined();
    expect(fresh.json<Json>().data.orderCreate.order.id).toMatch(/^ord_/);
    expect(await ordersOfShopA()).toBe(before + 1);
    // Claiming a key sweeps the shop's expired ones.
    const { rows } = await admin.query<{ key: string }>(
      'SELECT key FROM platform.idempotency_keys ORDER BY key',
    );
    expect(rows).toEqual([{ key: 'old' }]);
  });
});

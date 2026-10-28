import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STORE = 'shopId name currencyCode priceRate copiedAt lastCopy { created updated problems }';
const SAVE = `mutation ($shopId: ID!, $rate: String!) {
  expansionStoreSave(shopId: $shopId, priceRate: $rate) {
    expansionStore { ${STORE} } userErrors { field message } } }`;
const COPY = `mutation ($shopId: ID!) {
  expansionStoreCopy(shopId: $shopId) { expansionStore { ${STORE} } userErrors { message } } }`;
const PRODUCTS =
  '{ products(first: 10) { nodes { title status variants { price { amount currencyCode } } } } }';

describe.skipIf(!server)('Expansion stores (CH-11)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const zari = newId();
  const abroad = newId();
  const other = newId();

  async function account(shops: [string, StaffRole][]): Promise<{ token: string; userId: string }> {
    const post = (url: string, payload: object, token?: string) =>
      api.app.inject({
        method: 'POST',
        url,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const body = (
      await post('/auth/sign-up', {
        email: `expansion-${randomBytes(4).toString('hex')}@example.pk`,
        password: 'correct horse battery staple',
        name: 'Saima Rauf',
      })
    ).json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    for (const [shop, role] of shops) {
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [userId, shop, role],
      );
    }
    const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
      secret: string;
    };
    await post(
      '/auth/two-step/totp/confirm',
      { code: totp(base32Decode(secret), Date.now()) },
      body.accessToken,
    );
    return { token: body.accessToken, userId };
  }

  async function data(token: string, shop: string, query: string, variables?: object) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json>; errors?: Json[] };
    return body;
  }
  const value = async (token: string, shop: string, query: string, variables?: object) => {
    const body = await data(token, shop, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, currency)
       VALUES ($1, 'Zari', 'zari', 'PKR'), ($2, 'Zari Abroad', 'zari-abroad', 'USD'),
              ($3, 'Someone else', 'someone-else', 'USD')`,
      [zari, abroad, other],
    );
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("copies the owner's products to their other shop at its rate, and updates them when copied again", async () => {
    const owner = await account([
      [zari, 'owner'],
      [abroad, 'owner'],
      [other, 'manager'],
    ]);
    await value(
      owner.token,
      zari,
      'mutation { productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,500" }] }) { product { id } } }',
    );

    // Neither a shop not owned, nor the shop itself, nor a rate of nothing.
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', other), rate: '0.0036' }))
        .userErrors,
    ).toEqual([{ field: ['shopId'], message: 'You own no other shop of that ID' }]);
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', zari), rate: '1' }))
        .userErrors,
    ).toEqual([{ field: ['shopId'], message: "A shop isn't its own expansion store" }]);
    expect(
      (await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', abroad), rate: '0' }))
        .userErrors,
    ).toEqual([
      { field: ['priceRate'], message: 'Give the rate as a number above nothing, such as 0.0036' },
    ]);

    const saved = await value(owner.token, zari, SAVE, {
      shopId: toPublicId('shop', abroad),
      rate: '0.0036',
    });
    expect(saved.expansionStore).toEqual({
      shopId: toPublicId('shop', abroad),
      name: 'Zari Abroad',
      currencyCode: 'USD',
      priceRate: '0.0036',
      copiedAt: null,
      lastCopy: null,
    });

    const copied = await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect(copied.expansionStore.lastCopy).toEqual({ created: 1, updated: 0, problems: 0 });
    expect(copied.expansionStore.copiedAt).toEqual(expect.any(String));
    expect((await value(owner.token, abroad, PRODUCTS)).nodes).toEqual([
      {
        title: 'Kurta',
        status: 'ACTIVE',
        variants: [{ price: { amount: '9.00', currencyCode: 'USD' } }],
      },
    ]);

    // A new price here, copied again: updated there, not made twice.
    await value(owner.token, zari, SAVE, { shopId: toPublicId('shop', abroad), rate: '0.004' });
    const again = await value(owner.token, zari, COPY, { shopId: toPublicId('shop', abroad) });
    expect(again.expansionStore.lastCopy).toEqual({ created: 0, updated: 1, problems: 0 });
    expect((await value(owner.token, abroad, PRODUCTS)).nodes[0].variants).toEqual([
      { price: { amount: '10.00', currencyCode: 'USD' } },
    ]);
    expect(await value(owner.token, zari, `{ expansionStores { name priceRate } }`)).toEqual([
      { name: 'Zari Abroad', priceRate: '0.004' },
    ]);

    // A manager of the shop keeps none of it.
    const manager = await account([[zari, 'manager']]);
    expect(
      (await data(manager.token, zari, COPY, { shopId: toPublicId('shop', abroad) })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');

    expect(
      (
        await value(
          owner.token,
          zari,
          'mutation ($shopId: ID!) { expansionStoreRemove(shopId: $shopId) { userErrors { message } } }',
          { shopId: toPublicId('shop', abroad) },
        )
      ).userErrors,
    ).toEqual([]);
    expect(await value(owner.token, zari, '{ expansionStores { name } }')).toEqual([]);
    // What was copied stays.
    expect((await value(owner.token, abroad, PRODUCTS)).nodes).toHaveLength(1);
  });
});

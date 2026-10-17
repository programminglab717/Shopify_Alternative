import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { generateVapidKeys } from '@hatti/messaging/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STATUS = `query Status($endpoint: String) {
  pushNotifications(endpoint: $endpoint) { publicKey subscription { endpoint kinds } }
}`;
const SUBSCRIBE = `mutation Subscribe($input: PushSubscribeInput!) {
  pushSubscribe(input: $input) {
    subscription { endpoint kinds } userErrors { field code message }
  }
}`;
const UNSUBSCRIBE = `mutation Unsubscribe($endpoint: String!) {
  pushUnsubscribe(endpoint: $endpoint) { unsubscribed }
}`;

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/packer-phone';
const keys = { ...generateVapidKeys(), subject: 'mailto:push@hatti.pk' };
const input = (kinds: string[]) => ({
  endpoint: ENDPOINT,
  p256dh: 'B'.repeat(87),
  auth: 'a'.repeat(22),
  kinds,
});

describe.skipIf(!server)("Admin GraphQL API: pushes to staff's browsers (APP-03, ADR-506)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();
  let packer = '';
  let app = '';

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token.startsWith('hat_')
        ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
        : {
            authorization: `Bearer ${token}`,
            'x-hatti-shop-id': toPublicId('shop', shop),
            'idempotency-key': randomUUID(),
          },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb, { push: keys });
    const signedUp = await api.app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: {
        email: `push-${randomBytes(4).toString('hex')}@example.pk`,
        password: PASSWORD,
        name: 'Omar',
      },
    });
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    packer = body.accessToken;
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'packer')`,
      [fromPublicId(body.user.id, 'user'), shop],
    );
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{}')`,
      [shop, hash, hint],
    );
    app = token;
  });

  afterAll(async () => {
    await admin?.end();
    await api?.close();
    await testDb?.drop();
  });

  it("subscribes a member of staff's browser, whatever their role, and turns it off", async () => {
    expect(await gql(packer, STATUS, { endpoint: ENDPOINT })).toEqual({
      publicKey: keys.publicKey,
      subscription: null,
    });
    expect(await gql(packer, SUBSCRIBE, { input: input(['NEW_ORDER', 'LOW_STOCK']) })).toEqual({
      subscription: { endpoint: ENDPOINT, kinds: ['NEW_ORDER', 'LOW_STOCK'] },
      userErrors: [],
    });
    expect(await gql(packer, STATUS, { endpoint: ENDPOINT })).toEqual({
      publicKey: keys.publicKey,
      subscription: { endpoint: ENDPOINT, kinds: ['NEW_ORDER', 'LOW_STOCK'] },
    });
    expect(await gql(packer, UNSUBSCRIBE, { endpoint: ENDPOINT })).toEqual({ unsubscribed: true });
    expect(await gql(packer, STATUS, { endpoint: ENDPOINT })).toMatchObject({
      subscription: null,
    });
  });

  it('subscribes no app', async () => {
    expect(await gql(app, SUBSCRIBE, { input: input(['NEW_ORDER']) })).toMatchObject({
      subscription: null,
      userErrors: [{ field: ['input'], code: 'INVALID' }],
    });
    expect(await gql(app, STATUS)).toEqual({ publicKey: keys.publicKey, subscription: null });
  });
});

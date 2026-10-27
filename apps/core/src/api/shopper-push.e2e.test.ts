import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { generateVapidKeys } from '@hatti/messaging/public';
import { StorefrontApiClient, pushSubscriptionsPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const keys = { ...generateVapidKeys(), subject: 'mailto:push@hatti.pk' };

describe.skipIf(!server)("Pushes to the online store's shoppers (OS-14, ADR-833, ADR-834)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { marketer: '', reader: '' };

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, scopes],
    );
    return token;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.marketer = await issueToken(['write_marketing_events']);
    tokens.reader = await issueToken(['read_products']);
    api = await startTestApi(testDb, { push: keys });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps shoppers' subscriptions from the storefront, and sends the shop's campaigns", async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'B'.repeat(87),
      auth: 'a'.repeat(22),
      locale: 'ur' as const,
    };
    // Only the storefront, with its key.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: pushSubscriptionsPath(shop),
          payload: subscription,
        })
      ).statusCode,
    ).toBe(401);
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    expect(await client.pushSubscribe(shop, subscription)).toEqual({ ok: true });
    expect(
      await client.pushSubscribe(shop, { ...subscription, endpoint: 'https://10.0.0.1/hook' }),
    ).toEqual({
      ok: false,
      errors: [{ field: 'endpoint', message: "The browser's push service isn't one Hatti knows" }],
    });

    const PUSHES = '{ shopperPushes { available subscribers perDay campaigns { title status } } }';
    expect((await gql(tokens.marketer, PUSHES)).data?.shopperPushes).toEqual({
      available: true,
      subscribers: 1,
      perDay: 3,
      campaigns: [],
    });
    const SEND = `mutation ($input: PushCampaignInput!) {
      pushCampaignSend(input: $input) {
        campaign { id title body path status sent }
        userErrors { field code }
      }
    }`;
    expect(
      (
        await gql(tokens.marketer, SEND, {
          input: { title: 'Eid sale', body: '30% off lawn', path: '/collections/eid' },
        })
      ).data?.pushCampaignSend,
    ).toEqual({
      campaign: {
        id: expect.stringMatching(/^pcmp_/),
        title: 'Eid sale',
        body: '30% off lawn',
        path: '/collections/eid',
        status: 'SENDING',
        sent: 0,
      },
      userErrors: [],
    });
    expect(
      (await gql(tokens.marketer, SEND, { input: { title: 'x', body: 'y', path: '//evil' } })).data
        ?.pushCampaignSend.userErrors,
    ).toEqual([{ field: ['input', 'path'], code: 'INVALID' }]);
    // Those who send no marketing send none, nor see them.
    expect((await gql(tokens.reader, PUSHES)).errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    await client.pushUnsubscribe(shop, subscription.endpoint);
    expect((await gql(tokens.marketer, PUSHES)).data?.shopperPushes.subscribers).toBe(0);
  });
});

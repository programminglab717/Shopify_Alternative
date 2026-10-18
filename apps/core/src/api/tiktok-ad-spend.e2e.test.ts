import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const ACCOUNT = 'advertiserId name currency timezone accessTokenHint lastSyncedAt lastError';

const CONNECT = `mutation ($input: TikTokAdAccountConnectInput!) {
  tiktokAdAccountConnect(input: $input) {
    tiktokAdAccount { ${ACCOUNT} }
    userErrors { field code message }
  }
}`;

const SYNC = `mutation {
  tiktokAdSpendSync { tiktokAdAccount { lastError } userErrors { field code message } }
}`;

const ENTRIES = `query ($from: String!, $to: String!) {
  adSpendEntries(from: $from, to: $to) { platform day campaign amount { amount } source }
}`;

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0'.padEnd(40, 'f') + 'Tk12';
const ADVERTISER = '7012345678901234567';

/** Today in Karachi, `YYYY-MM-DD`. */
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe.skipIf(!server)("Admin GraphQL API: ad spend from TikTok's Business API (ADR-566)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let tiktok: Server;
  const shop = newId();
  const starter = newId();
  const tokens = { owner: '', reader: '', starter: '' };
  /** What the fake Business API answers for the advertiser. */
  let advertiser: { name: string; currency: string; timezone?: string };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    tiktok = createServer((request, response) => {
      const report = request.url?.includes('/open_api/v1.3/report/integrated/get/');
      const data = report
        ? {
            list: [
              {
                dimensions: { campaign_id: '1', stat_time_day: `${today()} 00:00:00` },
                metrics: { spend: '2500.5', campaign_name: 'Eid Sale' },
              },
            ],
            page_info: { page: 1, page_size: 1000, total_number: 1, total_page: 1 },
          }
        : { list: [{ advertiser_id: ADVERTISER, ...advertiser }] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, message: 'OK', data }));
    });
    await new Promise<void>((resolve) => tiktok.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(tiktok.address() as AddressInfo).port}`;

    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'S')`, [
      shop,
      starter,
    ]);
    // On Growth, which has true profit (ADR-529); the other on Starter, which does not.
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month'),
              ($2, 'starter', 'monthly', now(), now() + interval '1 month')`,
      [shop, starter],
    );
    tokens.owner = await issueToken(shop, ['write_pixels']);
    tokens.reader = await issueToken(shop, ['read_pixels']);
    tokens.starter = await issueToken(starter, ['write_pixels']);
    api = await startTestApi(testDb, { tiktokApi: { baseUrl } });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
    await new Promise<void>((resolve) => (tiktok ? tiktok.close(() => resolve()) : resolve()));
  });

  it("connects the shop's advertiser account, pulls its spend, and disconnects it keeping what was pulled", async () => {
    expect(await data(tokens.owner, `{ tiktokAdAccount { ${ACCOUNT} } }`)).toBeNull();
    advertiser = { name: 'Zari TikTok', currency: 'USD' };
    const input = { advertiserId: ADVERTISER, accessToken: TOKEN };
    expect(await data(tokens.owner, CONNECT, { input })).toEqual({
      tiktokAdAccount: null,
      userErrors: [
        {
          field: ['input', 'advertiserId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this advertiser account bills in USD',
        },
      ],
    });
    advertiser = { name: 'Zari TikTok', currency: 'PKR' };
    expect((await data(tokens.starter, CONNECT, { input })).userErrors).toEqual([
      {
        field: ['input'],
        code: 'INVALID',
        message:
          "The Starter plan doesn't include true profit: choose a bigger plan to connect TikTok's ad spend",
      },
    ]);

    advertiser = { name: 'Zari TikTok', currency: 'PKR', timezone: 'Asia/Karachi' };
    const connected = await data(tokens.owner, CONNECT, { input });
    expect(connected).toEqual({
      tiktokAdAccount: {
        advertiserId: ADVERTISER,
        name: 'Zari TikTok',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        accessTokenHint: 'Tk12',
        lastSyncedAt: expect.any(String),
        lastError: null,
      },
      userErrors: [],
    });
    expect(JSON.stringify(connected)).not.toContain(TOKEN.slice(0, 20));
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toEqual([
      {
        platform: 'TIKTOK',
        day: today(),
        campaign: 'Eid Sale',
        amount: { amount: '2500.50' },
        source: 'TIKTOK',
      },
    ]);
    // Typed over, it is the shop's.
    const typed = await data(
      tokens.owner,
      `mutation ($entries: [AdSpendInput!]!) { adSpendSet(entries: $entries) { count } }`,
      { entries: [{ platform: 'TIKTOK', day: today(), campaign: 'Eid Sale', amount: '3000' }] },
    );
    expect(typed).toEqual({ count: 1 });
    expect((await data(tokens.reader, ENTRIES, { from: today(), to: today() }))[0]).toMatchObject({
      amount: { amount: '3000.00' },
      source: 'MANUAL',
    });

    // Pulled now: once a minute, and connecting pulled it just now.
    expect(await data(tokens.owner, SYNC)).toEqual({
      tiktokAdAccount: null,
      userErrors: [
        {
          field: ['base'],
          code: 'INVALID',
          message: 'Its spend was pulled under a minute ago: try again in a minute',
        },
      ],
    });
    await admin.query(
      `UPDATE marketing.tiktok_ad_accounts SET last_attempt_at = now() - interval '2 minutes'`,
    );
    expect(await data(tokens.owner, SYNC)).toEqual({
      tiktokAdAccount: { lastError: null },
      userErrors: [],
    });
    // What the shop typed stays.
    expect((await data(tokens.reader, ENTRIES, { from: today(), to: today() }))[0]).toMatchObject({
      source: 'MANUAL',
    });

    for (const [token, query] of [
      [tokens.reader, CONNECT],
      [tokens.reader, SYNC],
      [tokens.reader, 'mutation { tiktokAdAccountDisconnect { deletedAdvertiserId } }'],
    ] as const) {
      const denied = await gql(token, query, { input });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    expect(await data(tokens.reader, `{ tiktokAdAccount { advertiserId } }`)).toEqual({
      advertiserId: ADVERTISER,
    });

    const disconnect =
      'mutation { tiktokAdAccountDisconnect { deletedAdvertiserId userErrors { code } } }';
    expect(await data(tokens.owner, disconnect)).toEqual({
      deletedAdvertiserId: ADVERTISER,
      userErrors: [],
    });
    expect(await data(tokens.owner, `{ tiktokAdAccount { advertiserId } }`)).toBeNull();
    expect(await data(tokens.owner, SYNC)).toMatchObject({
      userErrors: [{ code: 'NOT_FOUND', message: 'Connect a TikTok advertiser account first' }],
    });
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toHaveLength(1);
  });
});

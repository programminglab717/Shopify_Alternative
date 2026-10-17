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

const ACCOUNT = 'adAccountId name currency timezone accessTokenHint lastSyncedAt lastError';

const CONNECT = `mutation ($input: MetaAdAccountConnectInput!) {
  metaAdAccountConnect(input: $input) {
    metaAdAccount { ${ACCOUNT} }
    userErrors { field code message }
  }
}`;

const SYNC = `mutation {
  metaAdSpendSync { metaAdAccount { lastError } userErrors { field code message } }
}`;

const ENTRIES = `query ($from: String!, $to: String!) {
  adSpendEntries(from: $from, to: $to) { platform day campaign amount { amount } source }
}`;

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Ab12';

/** Today in Karachi, `YYYY-MM-DD`. */
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe.skipIf(!server)("Admin GraphQL API: ad spend from Meta's Marketing API (ADR-564)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let graph: Server;
  const shop = newId();
  const starter = newId();
  const tokens = { owner: '', reader: '', starter: '' };
  /** What the fake Graph API answers for the ad account. */
  let account: { status: number; body: unknown };

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
    graph = createServer((request, response) => {
      const insights = request.url?.includes('/insights');
      const answer = insights
        ? {
            status: 200,
            body: { data: [{ campaign_name: 'Eid Sale', spend: '2500.5', date_start: today() }] },
          }
        : account;
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

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
    api = await startTestApi(testDb, { metaGraph: { baseUrl, version: 'v26.0' } });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
    await new Promise<void>((resolve) => (graph ? graph.close(() => resolve()) : resolve()));
  });

  it("connects the shop's ad account, pulls its spend, and disconnects it keeping what was pulled", async () => {
    expect(await data(tokens.owner, `{ metaAdAccount { ${ACCOUNT} } }`)).toBeNull();
    account = { status: 200, body: { name: 'Zari Ads', currency: 'USD' } };
    const input = { adAccountId: 'act_123456789', accessToken: TOKEN };
    expect(await data(tokens.owner, CONNECT, { input })).toEqual({
      metaAdAccount: null,
      userErrors: [
        {
          field: ['input', 'adAccountId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this ad account bills in USD',
        },
      ],
    });
    account = { status: 200, body: { name: 'Zari Ads', currency: 'PKR' } };
    expect((await data(tokens.starter, CONNECT, { input })).userErrors).toEqual([
      {
        field: ['input'],
        code: 'INVALID',
        message:
          "The Starter plan doesn't include true profit: choose a bigger plan to connect Meta's ad spend",
      },
    ]);

    account = {
      status: 200,
      body: { name: 'Zari Ads', currency: 'PKR', timezone_name: 'Asia/Karachi' },
    };
    const connected = await data(tokens.owner, CONNECT, { input });
    expect(connected).toEqual({
      metaAdAccount: {
        adAccountId: '123456789',
        name: 'Zari Ads',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        accessTokenHint: 'Ab12',
        lastSyncedAt: expect.any(String),
        lastError: null,
      },
      userErrors: [],
    });
    expect(JSON.stringify(connected)).not.toContain(TOKEN.slice(0, 20));
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toEqual([
      {
        platform: 'META',
        day: today(),
        campaign: 'Eid Sale',
        amount: { amount: '2500.50' },
        source: 'META',
      },
    ]);
    // Typed over, it is the shop's.
    const typed = await data(
      tokens.owner,
      `mutation ($entries: [AdSpendInput!]!) { adSpendSet(entries: $entries) { count } }`,
      { entries: [{ platform: 'META', day: today(), campaign: 'Eid Sale', amount: '3000' }] },
    );
    expect(typed).toEqual({ count: 1 });
    expect((await data(tokens.reader, ENTRIES, { from: today(), to: today() }))[0]).toMatchObject({
      amount: { amount: '3000.00' },
      source: 'MANUAL',
    });

    // Pulled now: once a minute, and connecting pulled it just now.
    expect(await data(tokens.owner, SYNC)).toEqual({
      metaAdAccount: null,
      userErrors: [
        {
          field: ['base'],
          code: 'INVALID',
          message: 'Its spend was pulled under a minute ago: try again in a minute',
        },
      ],
    });
    await admin.query(
      `UPDATE marketing.meta_ad_accounts SET last_attempt_at = now() - interval '2 minutes'`,
    );
    expect(await data(tokens.owner, SYNC)).toEqual({
      metaAdAccount: { lastError: null },
      userErrors: [],
    });
    // What the shop typed stays.
    expect((await data(tokens.reader, ENTRIES, { from: today(), to: today() }))[0]).toMatchObject({
      source: 'MANUAL',
    });

    for (const [token, query] of [
      [tokens.reader, CONNECT],
      [tokens.reader, SYNC],
      [tokens.reader, 'mutation { metaAdAccountDisconnect { deletedAdAccountId } }'],
    ] as const) {
      const denied = await gql(token, query, { input });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    expect(await data(tokens.reader, `{ metaAdAccount { adAccountId } }`)).toEqual({
      adAccountId: '123456789',
    });

    const disconnect =
      'mutation { metaAdAccountDisconnect { deletedAdAccountId userErrors { code } } }';
    expect(await data(tokens.owner, disconnect)).toEqual({
      deletedAdAccountId: '123456789',
      userErrors: [],
    });
    expect(await data(tokens.owner, `{ metaAdAccount { adAccountId } }`)).toBeNull();
    expect(await data(tokens.owner, SYNC)).toMatchObject({
      userErrors: [{ code: 'NOT_FOUND', message: 'Connect a Meta ad account first' }],
    });
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toHaveLength(1);
  });
});

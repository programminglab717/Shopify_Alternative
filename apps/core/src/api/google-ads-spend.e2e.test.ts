import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ACCOUNT = 'customerId name currency timezone grantHint lastSyncedAt lastError';

const CONNECT = `mutation ($input: GoogleAdsAccountConnectInput!) {
  googleAdsAccountConnect(input: $input) {
    googleAdsAccount { ${ACCOUNT} }
    userErrors { field code message }
  }
}`;

const CONSENT = `query ($redirectUri: String!, $state: String!) {
  googleAdsConsentUrl(redirectUri: $redirectUri, state: $state)
}`;

const SYNC = `mutation {
  googleAdsSpendSync { googleAdsAccount { lastError } userErrors { field code message } }
}`;

const ENTRIES = `query ($from: String!, $to: String!) {
  adSpendEntries(from: $from, to: $to) { platform day campaign amount { amount } source }
}`;

const REFRESH = '1//0g-refresh-token-of-the-grant-Rf12';
const REDIRECT = 'https://admin.hatti.pk/ad-spend';

/** Today in Karachi, `YYYY-MM-DD`. */
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe.skipIf(!server)('Admin GraphQL API: ad spend from the Google Ads API (ADR-678)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let unset: TestApi;
  let google: Server;
  const shop = newId();
  const starter = newId();
  const tokens = { owner: '', reader: '', starter: '' };
  /** What the fake Google Ads API answers for the account. */
  let customer: { descriptiveName: string; currencyCode: string; timeZone?: string };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
    on: TestApi = api,
  ) {
    const response = await on.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
    on: TestApi = api,
  ) {
    const body = await gql(token, query, variables, on);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    google = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let answer: unknown = { access_token: 'ya29.access', refresh_token: REFRESH };
        if (request.url?.endsWith('googleAds:searchStream')) {
          const { query } = JSON.parse(body) as { query: string };
          answer = [
            {
              results: query.includes('FROM customer')
                ? [{ customer }]
                : [
                    {
                      campaign: { id: '9', name: 'Eid Sale' },
                      segments: { date: today() },
                      metrics: { costMicros: '2500500000' },
                    },
                  ],
            },
          ];
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => google.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;

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
    const googleAds = {
      baseUrl,
      version: 'v21',
      authorizeUrl: `${baseUrl}/auth`,
      tokenUrl: `${baseUrl}/token`,
    };
    api = await startTestApi(testDb, {
      googleAds: {
        ...googleAds,
        developerToken: 'developer-token-0001',
        clientId: 'hatti.apps.googleusercontent.com',
        clientSecret: 'client-secret-0001',
      },
    });
    unset = await startTestApi(testDb, { googleAds });
  });

  afterAll(async () => {
    await api?.close();
    await unset?.close();
    await admin?.end();
    await testDb?.drop();
    await new Promise<void>((resolve) => (google ? google.close(() => resolve()) : resolve()));
  });

  it("connects the shop's Google Ads account with its owner's grant, pulls its spend, and disconnects it keeping what was pulled", async () => {
    expect(await data(tokens.owner, `{ googleAdsAccount { ${ACCOUNT} } }`)).toBeNull();
    const consent = new URL(
      await data(tokens.owner, CONSENT, { redirectUri: REDIRECT, state: 'abc' }),
    );
    expect(consent.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(consent.searchParams.get('state')).toBe('abc');
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(
      await data(tokens.owner, CONSENT, { redirectUri: 'http://admin.hatti.pk', state: 'abc' }),
    ).toBeNull();
    expect(
      await data(tokens.owner, CONSENT, { redirectUri: REDIRECT, state: 'abc' }, unset),
    ).toBeNull();

    const input = { customerId: '123-456-7890', code: '4/0AeaYSH-code', redirectUri: REDIRECT };
    expect(await data(tokens.owner, CONNECT, { input }, unset)).toEqual({
      googleAdsAccount: null,
      userErrors: [
        { field: ['base'], code: 'UNAVAILABLE', message: 'Google Ads is not set up on this Hatti' },
      ],
    });
    customer = { descriptiveName: 'Zari Google', currencyCode: 'USD' };
    expect(await data(tokens.owner, CONNECT, { input })).toEqual({
      googleAdsAccount: null,
      userErrors: [
        {
          field: ['input', 'customerId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this Google Ads account bills in USD',
        },
      ],
    });
    customer = { descriptiveName: 'Zari Google', currencyCode: 'PKR', timeZone: 'Asia/Karachi' };
    expect((await data(tokens.starter, CONNECT, { input })).userErrors).toEqual([
      {
        field: ['input'],
        code: 'INVALID',
        message:
          "The Starter plan doesn't include true profit: choose a bigger plan to connect Google's ad spend",
      },
    ]);

    const connected = await data(tokens.owner, CONNECT, { input });
    expect(connected).toEqual({
      googleAdsAccount: {
        customerId: '1234567890',
        name: 'Zari Google',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        grantHint: 'Rf12',
        lastSyncedAt: expect.any(String),
        lastError: null,
      },
      userErrors: [],
    });
    expect(JSON.stringify(connected)).not.toContain(REFRESH.slice(0, 20));
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toEqual([
      {
        platform: 'GOOGLE',
        day: today(),
        campaign: 'Eid Sale',
        amount: { amount: '2500.50' },
        source: 'GOOGLE',
      },
    ]);

    // Pulled now: once a minute, and connecting pulled it just now.
    expect(await data(tokens.owner, SYNC)).toMatchObject({
      googleAdsAccount: null,
      userErrors: [{ field: ['base'], code: 'INVALID' }],
    });
    await admin.query(
      `UPDATE marketing.google_ads_accounts SET last_attempt_at = now() - interval '2 minutes'`,
    );
    expect(await data(tokens.owner, SYNC)).toEqual({
      googleAdsAccount: { lastError: null },
      userErrors: [],
    });

    for (const query of [
      CONNECT,
      SYNC,
      'mutation { googleAdsAccountDisconnect { deletedCustomerId } }',
    ]) {
      const denied = await gql(tokens.reader, query, { input });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    const consentDenied = await gql(tokens.reader, CONSENT, { redirectUri: REDIRECT, state: 'x' });
    expect(consentDenied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await data(tokens.reader, `{ googleAdsAccount { customerId } }`)).toEqual({
      customerId: '1234567890',
    });

    const disconnect =
      'mutation { googleAdsAccountDisconnect { deletedCustomerId userErrors { code } } }';
    expect(await data(tokens.owner, disconnect)).toEqual({
      deletedCustomerId: '1234567890',
      userErrors: [],
    });
    expect(await data(tokens.owner, `{ googleAdsAccount { customerId } }`)).toBeNull();
    expect(await data(tokens.owner, SYNC)).toMatchObject({
      userErrors: [{ code: 'NOT_FOUND', message: 'Connect a Google Ads account first' }],
    });
    expect(await data(tokens.reader, ENTRIES, { from: today(), to: today() })).toHaveLength(1);
  });
});

import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlanAllowance, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdSpendService } from './ad-spend.service.js';
import { GoogleAdsAccountService } from './google-ads-account.service.js';
import {
  GOOGLE_ADS_SCOPE,
  GoogleAdsClient,
  customerIdOf,
  customerIdShown,
  microsToSpend,
  type GoogleAdsOptions,
} from './google-ads-spend.js';
import { googleAdsAccounts } from './schema.js';
import { TikTokAdAccountService } from './tiktok-ad-account.service.js';
import { TikTokAdsClient } from './tiktok-ad-spend.js';

/** Starter: no true profit (ADR-529). */
class Starter extends PlanAllowance {
  async limitOf(): Promise<null> {
    return null;
  }

  async limitIn(): Promise<null> {
    return null;
  }

  async excludes(_shopId: string, feature: string): Promise<string | null> {
    return feature === 'trueProfit' ? 'Starter' : null;
  }
}

const server = testDatabaseServer();

const CUSTOMER = '1234567890';
const DEVELOPER_TOKEN = 'dev-token-of-hatti-0123';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-01';
const REDIRECT = 'https://admin.hatti.pk/settings/ad-spend';
const REFRESH = '1//0g-refresh-token-of-the-grant-Rf12';
const OTHER_REFRESH = '1//0g-another-refresh-token-Rf34';
const ACCESS = 'ya29.access-token-for-an-hour';

/** 17 October 2026, 2 am in Karachi: still the 16th in UTC. */
const NOW = new Date('2026-10-16T21:00:00Z');

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_pixels']),
  };
}

const UNSET: GoogleAdsOptions = {
  baseUrl: 'https://googleads.googleapis.com',
  version: 'v21',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

describe('Google Ads spend: reading what Google writes (ADR-678)', () => {
  it('takes the customer ID as Google Ads shows it, and its micros as money', () => {
    expect(customerIdOf('123-456-7890')).toBe(CUSTOMER);
    expect(customerIdOf(' 1234567890 ')).toBe(CUSTOMER);
    expect(customerIdOf('123-456-789')).toBeNull();
    expect(customerIdOf('act_1234567890')).toBeNull();
    expect(customerIdShown(CUSTOMER)).toBe('123-456-7890');
    expect(microsToSpend('1500500000')).toBe('1500.500000');
    expect(microsToSpend('999')).toBe('0.000999');
    expect(microsToSpend('0')).toBe('0.000000');
    expect(microsToSpend('-5')).toBeNull();
    expect(microsToSpend('1.5')).toBeNull();
  });

  it('sends the owner to Google asking for a lasting grant, where Hatti has its credentials', () => {
    expect(new GoogleAdsClient(UNSET).configured).toBe(false);
    expect(new GoogleAdsClient(UNSET).consentUrl(REDIRECT, 'abc')).toBeNull();
    // Two of three is not set up.
    expect(
      new GoogleAdsClient({ ...UNSET, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
        .configured,
    ).toBe(false);
    const client = new GoogleAdsClient({
      ...UNSET,
      developerToken: DEVELOPER_TOKEN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const url = new URL(client.consentUrl(REDIRECT, 'shop-state')!);
    expect(url.origin + url.pathname).toBe(UNSET.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: GOOGLE_ADS_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'shop-state',
    });
  });
});

describe.skipIf(!server)(
  "Google Ads spend: the shop's Google Ads account, and its spend pulled (ADR-678)",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let api: Server;
    let apiUrl: string;
    let options: GoogleAdsOptions;
    let accounts: GoogleAdsAccountService;
    let spend: AdSpendService;
    const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
    const a = tenant(newId());
    const b = tenant(newId());

    /** What the fake Google was asked, and what it answers. */
    const requests: {
      path: string;
      body: Record<string, string>;
      authorization?: string;
      developerToken?: string;
    }[] = [];
    let token: { status: number; body: unknown };
    let customer: { status: number; body: unknown };
    let campaigns: { status: number; body: unknown };

    const stream = (results: unknown[]) => [{ results, fieldMask: '', requestId: 'r1' }];
    const report = (rows: [string, string, string][]) =>
      stream(
        rows.map(([date, name, costMicros], index) => ({
          campaign: {
            resourceName: `customers/${CUSTOMER}/campaigns/9${index}`,
            id: `9${index}`,
            name,
          },
          segments: { date },
          metrics: { costMicros },
        })),
      );
    const failure = (status: number, code: Record<string, string>, message: string) => ({
      status,
      body: [
        {
          error: {
            code: status,
            message,
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.ads.googleads.v21.errors.GoogleAdsFailure',
                errors: [{ errorCode: code, message }],
              },
            ],
          },
        },
      ],
    });

    const rows = async (shopId = a.shopId, platform = 'google') =>
      (
        await admin.query<{ day: string; campaign: string; amount: string; source: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, campaign, amount::text AS amount, source
             FROM marketing.ad_spend WHERE shop_id = $1 AND platform = $2
            ORDER BY day, campaign`,
          [shopId, platform],
        )
      ).rows.map((row) => [row.day, row.campaign, Number(row.amount), row.source]);

    beforeAll(async () => {
      api = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const url = new URL(request.url ?? '/', apiUrl);
          const text = Buffer.concat(chunks).toString();
          const body = (request.headers['content-type'] ?? '').includes('json')
            ? (JSON.parse(text) as Record<string, string>)
            : Object.fromEntries(new URLSearchParams(text));
          const developer = request.headers['developer-token'];
          requests.push({
            path: url.pathname,
            body,
            authorization: request.headers.authorization,
            developerToken: typeof developer === 'string' ? developer : undefined,
          });
          const answer =
            url.pathname === '/token'
              ? token
              : body.query?.includes('FROM customer')
                ? customer
                : campaigns;
          // A grant's code is used once; its refresh token after it, for an access token.
          const value =
            url.pathname === '/token' && token.status === 200 && body.grant_type === 'refresh_token'
              ? { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }
              : answer.body;
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        });
      });
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
      options = {
        baseUrl: apiUrl,
        version: 'v21',
        authorizeUrl: `${apiUrl}/auth`,
        tokenUrl: `${apiUrl}/token`,
        developerToken: DEVELOPER_TOKEN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      };

      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'google-ads-account-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
        a.shopId,
        b.shopId,
      ]);
      accounts = new GoogleAdsAccountService(db, box, new GoogleAdsClient(options));
      spend = new AdSpendService(db);
    });

    afterAll(async () => {
      await db?.close();
      await admin?.end();
      await testDb?.drop();
      await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
    });

    beforeEach(async () => {
      await admin.query(
        'DELETE FROM marketing.google_ads_accounts; DELETE FROM marketing.tiktok_ad_accounts; ' +
          'DELETE FROM marketing.ad_spend; DELETE FROM platform.outbox_events; ' +
          'DELETE FROM platform.audit_log',
      );
      requests.splice(0);
      token = {
        status: 200,
        body: {
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3599,
          scope: GOOGLE_ADS_SCOPE,
        },
      };
      customer = {
        status: 200,
        body: stream([
          {
            customer: {
              resourceName: `customers/${CUSTOMER}`,
              descriptiveName: 'Zari Google',
              currencyCode: 'PKR',
              timeZone: 'Asia/Karachi',
              manager: false,
            },
          },
        ]),
      };
      campaigns = { status: 200, body: report([]) };
    });

    const input = (code = '4/0AeaYSH-code', customerId = '123-456-7890') => ({
      customerId,
      code,
      redirectUri: REDIRECT,
    });

    it('matches the migrated tables', async () => {
      await db.tenant(a.shopId, (tx) => tx.select().from(googleAdsAccounts).limit(1));
    });

    it("connects once Google's grant reads an account billing in rupees, and pulls its last 30 days", async () => {
      expect(await accounts.get(a)).toBeNull();
      expect(accounts.consentUrl(REDIRECT, 'x')).toContain(`${apiUrl}/auth?`);
      expect(accounts.consentUrl('http://localhost:5173/ad-spend', 'x')).not.toBeNull();
      expect(accounts.consentUrl('http://admin.hatti.pk/ad-spend', 'x')).toBeNull();
      expect(accounts.consentUrl(REDIRECT, 'x'.repeat(501))).toBeNull();
      const wrong = await accounts.connect(
        a,
        { customerId: '12', code: 'two words', redirectUri: 'http://admin.hatti.pk' },
        NOW,
      );
      expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
        ['input.customerId', 'INVALID'],
        ['input.code', 'INVALID'],
        ['input.redirectUri', 'INVALID'],
      ]);
      expect(requests).toEqual([]);

      campaigns = {
        status: 200,
        body: report([
          ['2026-09-18', 'Eid Sale', '1500500000'],
          ['2026-10-17', ' Lawn  ', '99999000'],
          ['2026-09-17', 'Eid Sale', '700000000'],
        ]),
      };
      const connected = unwrap(await accounts.connect(a, input(), NOW));
      expect(connected).toEqual({
        customerId: CUSTOMER,
        name: 'Zari Google',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        tokenHint: 'Rf12',
        lastSyncedAt: NOW,
        lastError: null,
        updatedAt: expect.any(Date),
      });
      const [granted, refreshed, asked, refreshedAgain, pulled] = requests.splice(0);
      expect(granted).toMatchObject({
        path: '/token',
        body: {
          grant_type: 'authorization_code',
          code: '4/0AeaYSH-code',
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        },
      });
      expect(refreshed).toMatchObject({
        path: '/token',
        body: { grant_type: 'refresh_token', refresh_token: REFRESH },
      });
      // The access token and Hatti's developer token go in headers.
      expect(asked).toMatchObject({
        path: `/v21/customers/${CUSTOMER}/googleAds:searchStream`,
        authorization: `Bearer ${ACCESS}`,
        developerToken: DEVELOPER_TOKEN,
      });
      expect(asked!.body.query).toContain('FROM customer');
      expect(refreshedAgain!.path).toBe('/token');
      expect(pulled!.body.query).toBe(
        'SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros FROM campaign ' +
          "WHERE segments.date BETWEEN '2026-09-18' AND '2026-10-17' AND metrics.cost_micros > 0",
      );
      expect(await rows()).toEqual([
        ['2026-09-18', 'Eid Sale', 150_050, 'google_api'],
        ['2026-10-17', 'Lawn', 10_000, 'google_api'],
      ]);
      expect(unwrap(await spend.list(a, '2026-10-17', '2026-10-17'))).toEqual([
        {
          platform: 'google',
          day: '2026-10-17',
          campaign: 'Lawn',
          amount: 10_000n,
          source: 'google_api',
        },
      ]);

      // Kept sealed, for the shop alone; audited, the grant never.
      const { rows: sealed } = await admin.query<{ access_token: string }>(
        'SELECT access_token FROM marketing.google_ads_accounts',
      );
      expect(sealed[0]!.access_token).not.toContain(REFRESH.slice(0, 20));
      const { rows: audit } = await admin.query<{ action: string; details: string }>(
        'SELECT action, details::text FROM platform.audit_log ORDER BY id',
      );
      expect(audit.map((row) => row.action)).toEqual(['google_ads_account.connected']);
      expect(audit[0]!.details).not.toContain(REFRESH.slice(0, 20));
      expect(audit[0]!.details).not.toContain('4/0AeaYSH');
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        changed: ['customerId', 'accessToken'],
        customerId: CUSTOMER,
        tokenHint: 'Rf12',
        before: null,
      });
      const { rows: events } = await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events',
      );
      expect(events).toEqual([
        {
          event_type: 'google_ads_account.connected',
          payload: expect.objectContaining({
            customerId: CUSTOMER,
            changed: ['customerId', 'accessToken'],
          }),
        },
      ]);
      expect(await accounts.get(b)).toBeNull();
      // Sealed for Google's ad spend alone: TikTok's accounts know nothing of it.
      const tiktok = new TikTokAdAccountService(db, box, new TikTokAdsClient({ baseUrl: apiUrl }));
      expect(await tiktok.get(a)).toBeNull();

      // The same grant again changes nothing, and asks Google only to check it.
      unwrap(await accounts.connect(a, input(), NOW));
      expect(requests.splice(0).map((each) => each.body.grant_type ?? 'search')).toEqual([
        'authorization_code',
        'refresh_token',
        'search',
      ]);
      expect((await admin.query('SELECT 1 FROM platform.audit_log')).rowCount).toBe(1);

      // Disconnecting forgets the grant, and keeps the spend pulled.
      expect(await accounts.disconnect(a)).toBe(CUSTOMER);
      expect(await accounts.disconnect(a)).toBeNull();
      expect(await accounts.get(a)).toBeNull();
      expect(await rows()).toHaveLength(2);
      expect(await accounts.sync(a.shopId, NOW)).toBeNull();
      const { rows: last } = await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id DESC LIMIT 1',
      );
      expect(last[0]).toEqual({
        event_type: 'google_ads_account.disconnected',
        payload: expect.objectContaining({ customerId: CUSTOMER }),
      });
    });

    it('refuses what Google refuses, manager accounts, another currency, plans without true profit, and an unset Hatti', async () => {
      const connect = async (service = accounts) => {
        const result = await service.connect(a, input(), NOW);
        return result.ok ? result.value : result.errors;
      };
      token = { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: 'Google refused the grant: Bad Request',
        },
      ]);
      token = { status: 503, body: null };
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'UNAVAILABLE',
          message: 'Google could not answer just now: Google answered 503',
        },
      ]);
      token = { status: 401, body: { error: 'invalid_client', error_description: 'Unauthorized' } };
      expect(await connect()).toMatchObject([
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: "Google refused Hatti's sign-in: Unauthorized",
        },
      ]);
      // A grant given before, asked again without consent, has no refresh token.
      token = { status: 200, body: { access_token: ACCESS, expires_in: 3599 } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: 'Google gave no lasting grant: connect again, and allow access when asked',
        },
      ]);
      token = { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH } };

      customer = failure(403, { authorizationError: 'USER_PERMISSION_DENIED' }, 'No access');
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: 'Google refused the grant: No access',
        },
      ]);
      customer = failure(400, { requestError: 'CUSTOMER_NOT_FOUND' }, 'No customer');
      expect(await connect()).toEqual([
        {
          field: ['input', 'customerId'],
          code: 'INVALID',
          message: 'Google Ads refused the account: No customer',
        },
      ]);
      customer = failure(
        403,
        { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' },
        'Only test accounts',
      );
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'INVALID',
          message: 'Google Ads refused Hatti: Only test accounts',
        },
      ]);
      customer = failure(429, { quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many requests');
      expect(await connect()).toEqual([
        {
          field: ['input', 'code'],
          code: 'UNAVAILABLE',
          message: 'Google Ads could not answer just now: Too many requests',
        },
      ]);
      customer = {
        status: 200,
        body: stream([
          { customer: { descriptiveName: 'MCC', currencyCode: 'PKR', manager: true } },
        ]),
      };
      expect(await connect()).toEqual([
        {
          field: ['input', 'customerId'],
          code: 'INVALID',
          message: 'This is a manager account: give the ID of the account that runs the ads',
        },
      ]);
      customer = { status: 200, body: stream([]) };
      expect(await connect()).toMatchObject([
        { field: ['input', 'customerId'], message: 'Google has no such Google Ads account' },
      ]);
      customer = {
        status: 200,
        body: stream([{ customer: { descriptiveName: 'Dollar Ads', currencyCode: 'USD' } }]),
      };
      expect(await connect()).toEqual([
        {
          field: ['input', 'customerId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this Google Ads account bills in USD',
        },
      ]);

      const starter = new GoogleAdsAccountService(
        db,
        box,
        new GoogleAdsClient(options),
        new Starter(),
      );
      // A name of nothing is the account's ID, as Google Ads shows it.
      customer = {
        status: 200,
        body: stream([{ customer: { descriptiveName: ' ', currencyCode: 'PKR' } }]),
      };
      requests.splice(0);
      expect(await connect(starter)).toEqual([
        {
          field: ['input'],
          code: 'INVALID',
          message:
            "The Starter plan doesn't include true profit: choose a bigger plan to connect Google's ad spend",
        },
      ]);
      // The plan is asked before Google is: the code is not spent.
      expect(requests).toEqual([]);
      expect(await accounts.get(a)).toBeNull();
      // One connected before stays on the smaller plan, and may take another grant there.
      expect(await connect()).toMatchObject({
        customerId: CUSTOMER,
        name: '123-456-7890',
        timezone: null,
      });
      token = { status: 200, body: { access_token: ACCESS, refresh_token: OTHER_REFRESH } };
      expect(unwrap(await starter.connect(a, input('4/other'), NOW)).tokenHint).toBe('Rf34');

      const unset = new GoogleAdsAccountService(db, box, new GoogleAdsClient(UNSET));
      expect(unset.consentUrl(REDIRECT, 'x')).toBeNull();
      expect(await unset.connect(b, input(), NOW)).toEqual({
        ok: false,
        errors: [
          {
            field: ['base'],
            code: 'UNAVAILABLE',
            message: 'Google Ads is not set up on this Hatti',
          },
        ],
      });
      // An account connected before is still pulled from where Hatti is set up no more: it says so.
      expect(await unset.sync(a.shopId, new Date(NOW.getTime() + 3_600_000))).toEqual({
        ok: false,
        message: 'Google Ads is not set up on this Hatti',
      });
    });

    it("keeps what the shop typed, and puts Google's last week in the place of what was pulled of it", async () => {
      unwrap(await accounts.connect(a, input(), NOW));
      unwrap(
        await spend.set(
          a,
          [
            // Typed by hand: a campaign Google reports, and Google's whole day on another day.
            { platform: 'google', day: '2026-10-15', campaign: 'EID SALE', amount: '5000' },
            { platform: 'google', day: '2026-10-14', amount: '8000' },
            // Another platform is not Google's to replace.
            { platform: 'meta', day: '2026-10-15', campaign: 'Eid Sale', amount: '100' },
          ],
          NOW,
        ),
      );
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
         VALUES ($1, 'google', '2026-10-16', 'Lawn', 1000, 'google_api'),
                ($1, 'google', '2026-10-12', 'Gone', 1000, 'google_api'),
                ($1, 'google', '2026-10-10', 'Older', 1000, 'google_api')`,
        [a.shopId],
      );
      campaigns = {
        status: 200,
        // Streamed in two batches.
        body: [
          ...report([
            ['2026-10-15', 'Eid Sale', '9999000000'],
            ['2026-10-15', 'Brand', '250000000'],
            ['2026-10-14', 'Brand', '300000000'],
          ]),
          ...report([
            ['2026-10-16', 'Lawn', '1200100000'],
            // The same campaign by another letter case is added up.
            ['2026-10-16', 'lawn', '10000000'],
            // A campaign with no name is its ID.
            ['2026-10-17', '', '1000000'],
          ]),
        ],
      };
      requests.splice(0);
      expect(await accounts.sync(a.shopId, new Date(NOW.getTime() + 3 * 3_600_000))).toEqual({
        ok: true,
        days: 7,
        entries: 3,
      });
      expect(requests.at(-1)!.body.query).toContain(
        "segments.date BETWEEN '2026-10-11' AND '2026-10-17'",
      );
      expect(await rows()).toEqual([
        ['2026-10-10', 'Older', 1000, 'google_api'],
        ['2026-10-14', '', 800_000, 'manual'],
        ['2026-10-15', 'Brand', 25_000, 'google_api'],
        ['2026-10-15', 'EID SALE', 500_000, 'manual'],
        ['2026-10-16', 'Lawn', 121_010, 'google_api'],
        ['2026-10-17', '92', 100, 'google_api'],
      ]);
      expect(await rows(a.shopId, 'meta')).toEqual([['2026-10-15', 'Eid Sale', 10_000, 'manual']]);
      // A platform's own pulled rows alone: Google's source is not Meta's platform.
      await expect(
        admin.query(
          `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
           VALUES ($1, 'meta', '2026-10-13', 'X', 1, 'google_api')`,
          [a.shopId],
        ),
      ).rejects.toThrow(/ad_spend_source_of_platform/);
    });

    it('keeps why a pull failed for the shop to see, trying again next time, and pulls now at most once a minute', async () => {
      unwrap(await accounts.connect(a, input(), NOW));
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
         VALUES ($1, 'google', '2026-10-16', 'Lawn', 1000, 'google_api')`,
        [a.shopId],
      );
      const later = new Date(NOW.getTime() + 3_600_000);
      // The owner took the grant back.
      token = {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      };
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'Google refused the grant: Token has been expired or revoked.',
      });
      expect(await accounts.get(a)).toMatchObject({
        lastSyncedAt: NOW,
        lastError: 'Google refused the grant: Token has been expired or revoked.',
      });
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'google_api']]);
      token = { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH } };
      campaigns = { status: 500, body: [{ error: { code: 500, message: 'Internal error' } }] };
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'Google Ads could not answer just now: Internal error',
      });
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'google_api']]);

      // Pulled now: once a minute.
      campaigns = { status: 200, body: [] };
      const pulled = unwrap(await accounts.pull(a, new Date(later.getTime() + 60_000)));
      expect(pulled).toMatchObject({
        lastError: null,
        lastSyncedAt: new Date(later.getTime() + 60_000),
      });
      // Google reports nothing for the week now: what was pulled of it goes.
      expect(await rows()).toEqual([]);
      expect(await accounts.pull(a, new Date(later.getTime() + 90_000))).toMatchObject({
        ok: false,
        errors: [{ field: ['base'], code: 'INVALID' }],
      });
      expect(await accounts.pull(b, later)).toEqual({
        ok: false,
        errors: [
          { field: ['base'], code: 'NOT_FOUND', message: 'Connect a Google Ads account first' },
        ],
      });

      // The worker's round: those asked longest ago first, or never.
      await admin.query(
        `INSERT INTO marketing.google_ads_accounts
                (shop_id, customer_id, name, currency, access_token, token_hint)
         VALUES ($1, '9999999999', 'B', 'PKR', 'sealed', 'Zz99')`,
        [b.shopId],
      );
      expect(await accounts.dueShops(new Date(later.getTime() + 120_000))).toEqual([
        b.shopId,
        a.shopId,
      ]);
      expect(await accounts.dueShops(later)).toEqual([b.shopId]);
      await expect(
        admin.query(
          `UPDATE marketing.google_ads_accounts SET customer_id = '123-456-7890'
            WHERE shop_id = $1`,
          [b.shopId],
        ),
      ).rejects.toThrow(/check/);
    });
  },
);

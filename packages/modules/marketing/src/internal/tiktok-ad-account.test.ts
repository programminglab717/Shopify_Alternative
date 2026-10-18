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
import { MetaAdAccountService } from './meta-ad-account.service.js';
import { MetaAdsClient } from './meta-ad-spend.js';
import { tiktokAdAccounts } from './schema.js';
import { TikTokAdAccountService } from './tiktok-ad-account.service.js';
import { TIKTOK_REPORT_PAGES, TikTokAdsClient, advertiserIdOf } from './tiktok-ad-spend.js';

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

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0'.padEnd(40, 'f') + 'Tk12';
const OTHER_TOKEN = 'ffffeeeeddddccccbbbb'.padEnd(40, 'e') + 'Tk34';
const ADVERTISER = '7012345678901234567';

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

describe('TikTok ad spend: reading what TikTok writes (ADR-566)', () => {
  it('takes the advertiser as TikTok Ads Manager shows it', () => {
    expect(advertiserIdOf(ADVERTISER)).toBe(ADVERTISER);
    expect(advertiserIdOf(' 7012 3456 7890 ')).toBe('701234567890');
    expect(advertiserIdOf('1234')).toBeNull();
    expect(advertiserIdOf('act_123456789')).toBeNull();
    expect(advertiserIdOf('')).toBeNull();
  });
});

describe.skipIf(!server)(
  "TikTok ad spend: the shop's advertiser account, and its spend pulled (ADR-566)",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let api: Server;
    let apiUrl: string;
    let accounts: TikTokAdAccountService;
    let spend: AdSpendService;
    const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
    const a = tenant(newId());
    const b = tenant(newId());

    /** What the fake Business API was asked, and what it answers. */
    const requests: { path: string; query: URLSearchParams; token: string | undefined }[] = [];
    let advertiser: { status: number; body: unknown };
    /** The report's pages, in turn, each saying how many there are. */
    let pages: { status: number; body: unknown }[];

    const report = (rows: [string, string, string][], page = 1, total = 1) => ({
      code: 0,
      message: 'OK',
      data: {
        list: rows.map(([day, campaign_name, spend], index) => ({
          dimensions: { campaign_id: `17${index}`, stat_time_day: `${day} 00:00:00` },
          metrics: { spend, campaign_name },
        })),
        page_info: { page, page_size: 1000, total_number: rows.length, total_page: total },
      },
    });

    const rows = async (shopId = a.shopId, platform = 'tiktok') =>
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
        const url = new URL(request.url ?? '/', apiUrl);
        const token = request.headers['access-token'];
        requests.push({
          path: url.pathname,
          query: url.searchParams,
          token: typeof token === 'string' ? token : undefined,
        });
        let answer = advertiser;
        if (url.pathname.endsWith('/report/integrated/get/')) {
          const page = Number(url.searchParams.get('page') ?? 1);
          answer = pages[page - 1] ?? { status: 200, body: report([], page, pages.length) };
        }
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'tiktok-ad-account-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
        a.shopId,
        b.shopId,
      ]);
      accounts = new TikTokAdAccountService(db, box, new TikTokAdsClient({ baseUrl: apiUrl }));
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
        'DELETE FROM marketing.tiktok_ad_accounts; DELETE FROM marketing.meta_ad_accounts; ' +
          'DELETE FROM marketing.ad_spend; DELETE FROM platform.outbox_events; ' +
          'DELETE FROM platform.audit_log',
      );
      requests.splice(0);
      advertiser = {
        status: 200,
        body: {
          code: 0,
          message: 'OK',
          data: {
            list: [
              {
                advertiser_id: ADVERTISER,
                name: 'Zari TikTok',
                currency: 'PKR',
                timezone: 'Asia/Karachi',
                status: 'STATUS_ENABLE',
              },
            ],
          },
        },
      };
      pages = [{ status: 200, body: report([]) }];
    });

    it('matches the migrated tables', async () => {
      await db.tenant(a.shopId, (tx) => tx.select().from(tiktokAdAccounts).limit(1));
    });

    it('connects once TikTok says the token reads an advertiser billing in rupees, and pulls its last 30 days', async () => {
      expect(await accounts.get(a)).toBeNull();
      const wrong = await accounts.connect(a, { advertiserId: '12', accessToken: 'short' }, NOW);
      expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
        ['input.advertiserId', 'INVALID'],
        ['input.accessToken', 'INVALID'],
      ]);
      expect(requests).toEqual([]);

      pages = [
        {
          status: 200,
          body: report([
            ['2026-09-18', 'Eid Sale', '1500.5'],
            ['2026-10-17', ' Lawn  ', '99.999'],
            // Nothing spent is no row; a day before the 30 is not the pull's.
            ['2026-10-16', 'Brand', '0.00'],
            ['2026-09-17', 'Eid Sale', '700'],
          ]),
        },
      ];
      const connected = unwrap(
        await accounts.connect(
          a,
          { advertiserId: ` ${ADVERTISER} `, accessToken: ` ${TOKEN} ` },
          NOW,
        ),
      );
      expect(connected).toEqual({
        advertiserId: ADVERTISER,
        name: 'Zari TikTok',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        tokenHint: 'Tk12',
        lastSyncedAt: NOW,
        lastError: null,
        updatedAt: expect.any(Date),
      });
      const [asked, pulled] = requests.splice(0);
      // The token goes in a header, never in the address.
      expect(asked).toMatchObject({ path: '/open_api/v1.3/advertiser/info/', token: TOKEN });
      expect(Object.fromEntries(asked!.query)).toEqual({
        advertiser_ids: `["${ADVERTISER}"]`,
        fields: '["name","currency","timezone","status"]',
      });
      expect(pulled).toMatchObject({ path: '/open_api/v1.3/report/integrated/get/', token: TOKEN });
      expect(Object.fromEntries(pulled!.query)).toEqual({
        advertiser_id: ADVERTISER,
        report_type: 'BASIC',
        data_level: 'AUCTION_CAMPAIGN',
        dimensions: '["campaign_id","stat_time_day"]',
        metrics: '["spend","campaign_name"]',
        start_date: '2026-09-18',
        end_date: '2026-10-17',
        page: '1',
        page_size: '1000',
      });
      expect(await rows()).toEqual([
        ['2026-09-18', 'Eid Sale', 150_050, 'tiktok_api'],
        ['2026-10-17', 'Lawn', 10_000, 'tiktok_api'],
      ]);
      expect(unwrap(await spend.list(a, '2026-10-17', '2026-10-17'))).toEqual([
        {
          platform: 'tiktok',
          day: '2026-10-17',
          campaign: 'Lawn',
          amount: 10_000n,
          source: 'tiktok_api',
        },
      ]);

      // Kept sealed, for the shop alone; audited, the token never.
      const { rows: sealed } = await admin.query<{ access_token: string }>(
        'SELECT access_token FROM marketing.tiktok_ad_accounts',
      );
      expect(sealed[0]!.access_token).not.toContain(TOKEN.slice(0, 20));
      const { rows: audit } = await admin.query<{ action: string; details: string }>(
        'SELECT action, details::text FROM platform.audit_log ORDER BY id',
      );
      expect(audit.map((row) => row.action)).toEqual(['tiktok_ad_account.connected']);
      expect(audit[0]!.details).not.toContain(TOKEN.slice(0, 20));
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        changed: ['advertiserId', 'accessToken'],
        advertiserId: ADVERTISER,
        tokenHint: 'Tk12',
        before: null,
      });
      const { rows: events } = await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events',
      );
      expect(events).toEqual([
        {
          event_type: 'tiktok_ad_account.connected',
          payload: expect.objectContaining({
            advertiserId: ADVERTISER,
            changed: ['advertiserId', 'accessToken'],
          }),
        },
      ]);
      expect(await accounts.get(b)).toBeNull();
      // Sealed for TikTok's ad spend alone: Meta's accounts know nothing of it.
      const meta = new MetaAdAccountService(
        db,
        box,
        new MetaAdsClient({ baseUrl: apiUrl, version: 'v26.0' }),
      );
      expect(await meta.get(a)).toBeNull();

      // The same again changes nothing, and asks TikTok only to check it.
      unwrap(await accounts.connect(a, { advertiserId: ADVERTISER, accessToken: TOKEN }, NOW));
      expect(requests.splice(0).map((each) => each.path)).toEqual([
        '/open_api/v1.3/advertiser/info/',
      ]);
      expect((await admin.query('SELECT 1 FROM platform.audit_log')).rowCount).toBe(1);

      // Disconnecting forgets the token, and keeps the spend pulled.
      expect(await accounts.disconnect(a)).toBe(ADVERTISER);
      expect(await accounts.disconnect(a)).toBeNull();
      expect(await accounts.get(a)).toBeNull();
      expect(await rows()).toHaveLength(2);
      expect(await accounts.sync(a.shopId, NOW)).toBeNull();
      const { rows: last } = await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events ORDER BY id DESC LIMIT 1',
      );
      expect(last[0]).toEqual({
        event_type: 'tiktok_ad_account.disconnected',
        payload: expect.objectContaining({ advertiserId: ADVERTISER }),
      });
    });

    it('refuses what TikTok refuses, an advertiser billing in another currency, and plans without true profit', async () => {
      const connect = async (service = accounts) => {
        const result = await service.connect(
          a,
          { advertiserId: ADVERTISER, accessToken: TOKEN },
          NOW,
        );
        return result.ok ? result.value : result.errors;
      };
      advertiser = {
        status: 200,
        body: { code: 40105, message: 'The access token is invalid or has been revoked.' },
      };
      expect(await connect()).toEqual([
        {
          field: ['input', 'accessToken'],
          code: 'INVALID',
          message: 'TikTok refused the token: The access token is invalid or has been revoked.',
        },
      ]);
      advertiser = {
        status: 200,
        body: { code: 40001, message: 'No permission to operate advertiser' },
      };
      expect(await connect()).toMatchObject([{ field: ['input', 'accessToken'], code: 'INVALID' }]);
      advertiser = { status: 200, body: { code: 0, message: 'OK', data: { list: [] } } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'advertiserId'],
          code: 'INVALID',
          message: 'TikTok has no such advertiser account',
        },
      ]);
      advertiser = { status: 200, body: { code: 40100, message: 'Too many requests' } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'accessToken'],
          code: 'UNAVAILABLE',
          message: 'TikTok could not answer just now: Too many requests',
        },
      ]);
      advertiser = { status: 503, body: null };
      expect(await connect()).toEqual([
        {
          field: ['input', 'accessToken'],
          code: 'UNAVAILABLE',
          message: 'TikTok could not answer just now: TikTok answered 503',
        },
      ]);
      advertiser = { status: 200, body: { code: 40700, message: 'Something else' } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'accessToken'],
          code: 'INVALID',
          message: 'TikTok refused it: Something else',
        },
      ]);
      advertiser = {
        status: 200,
        body: {
          code: 0,
          data: { list: [{ advertiser_id: ADVERTISER, name: 'Dollar Ads', currency: 'USD' }] },
        },
      };
      expect(await connect()).toEqual([
        {
          field: ['input', 'advertiserId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this advertiser account bills in USD',
        },
      ]);
      const starter = new TikTokAdAccountService(
        db,
        box,
        new TikTokAdsClient({ baseUrl: apiUrl }),
        new Starter(),
      );
      advertiser = {
        status: 200,
        body: {
          code: 0,
          // A name of nothing is the advertiser's ID.
          data: { list: [{ advertiser_id: ADVERTISER, name: ' ', currency: 'PKR' }] },
        },
      };
      expect(await connect(starter)).toEqual([
        {
          field: ['input'],
          code: 'INVALID',
          message:
            "The Starter plan doesn't include true profit: choose a bigger plan to connect TikTok's ad spend",
        },
      ]);
      expect(await accounts.get(a)).toBeNull();
      // One connected before stays on the smaller plan, and may take another token there.
      expect(await connect()).toMatchObject({
        advertiserId: ADVERTISER,
        name: ADVERTISER,
        timezone: null,
      });
      expect(
        unwrap(
          await starter.connect(a, { advertiserId: ADVERTISER, accessToken: OTHER_TOKEN }, NOW),
        ).tokenHint,
      ).toBe('Tk34');
    });

    it("keeps what the shop typed, and puts TikTok's last week, page by page, in the place of what was pulled of it", async () => {
      unwrap(await accounts.connect(a, { advertiserId: ADVERTISER, accessToken: TOKEN }, NOW));
      unwrap(
        await spend.set(
          a,
          [
            // Typed by hand: a campaign TikTok reports, and TikTok's whole day on another day.
            { platform: 'tiktok', day: '2026-10-15', campaign: 'EID SALE', amount: '5000' },
            { platform: 'tiktok', day: '2026-10-14', amount: '8000' },
            // Another platform is not TikTok's to replace.
            { platform: 'meta', day: '2026-10-15', campaign: 'Eid Sale', amount: '100' },
          ],
          NOW,
        ),
      );
      // Pulled before: TikTok still reports one of these, and no longer the others; and Meta's.
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
         VALUES ($1, 'tiktok', '2026-10-16', 'Lawn', 1000, 'tiktok_api'),
                ($1, 'tiktok', '2026-10-12', 'Gone', 1000, 'tiktok_api'),
                ($1, 'tiktok', '2026-10-10', 'Older', 1000, 'tiktok_api'),
                ($1, 'meta', '2026-10-16', 'Lawn', 1000, 'meta_api')`,
        [a.shopId],
      );
      pages = [
        {
          status: 200,
          body: report(
            [
              ['2026-10-15', 'Eid Sale', '9999'],
              ['2026-10-15', 'Brand', '250'],
              ['2026-10-14', 'Brand', '300'],
              ['2026-10-16', 'Lawn', '1200.10'],
            ],
            1,
            2,
          ),
        },
        {
          status: 200,
          body: report(
            [
              // The same campaign by another letter case, or twice, is added up.
              ['2026-10-16', 'lawn', '10'],
              ['2026-10-17', 'Lawn', '0'],
              ['2026-10-17', 'x'.repeat(250), '1'],
            ],
            2,
            2,
          ),
        },
      ];
      requests.splice(0);
      expect(await accounts.sync(a.shopId, new Date(NOW.getTime() + 3 * 3_600_000))).toEqual({
        ok: true,
        days: 7,
        entries: 3,
      });
      expect(requests.map((each) => each.query.get('page'))).toEqual(['1', '2']);
      expect([requests[0]!.query.get('start_date'), requests[0]!.query.get('end_date')]).toEqual([
        '2026-10-11',
        '2026-10-17',
      ]);
      expect(await rows()).toEqual([
        // Outside the week, kept as it was.
        ['2026-10-10', 'Older', 1000, 'tiktok_api'],
        // The shop's whole day keeps TikTok's campaigns of it out.
        ['2026-10-14', '', 800_000, 'manual'],
        // The shop's campaign stays as typed; TikTok's others come in.
        ['2026-10-15', 'Brand', 25_000, 'tiktok_api'],
        ['2026-10-15', 'EID SALE', 500_000, 'manual'],
        ['2026-10-16', 'Lawn', 121_010, 'tiktok_api'],
        ['2026-10-17', 'x'.repeat(200), 100, 'tiktok_api'],
      ]);
      expect(await rows(a.shopId, 'meta')).toEqual([
        ['2026-10-15', 'Eid Sale', 10_000, 'manual'],
        ['2026-10-16', 'Lawn', 1000, 'meta_api'],
      ]);

      // Typed over, a pulled campaign's day is the shop's; TikTok's whole day typed puts the
      // campaigns pulled for it away.
      unwrap(
        await spend.set(
          a,
          [
            { platform: 'tiktok', day: '2026-10-16', campaign: 'lawn', amount: '1300' },
            { platform: 'tiktok', day: '2026-10-15', amount: '7000' },
          ],
          NOW,
        ),
      );
      expect(
        (await rows()).filter(([day]) => day === '2026-10-15' || day === '2026-10-16'),
      ).toEqual([
        ['2026-10-15', '', 700_000, 'manual'],
        ['2026-10-15', 'EID SALE', 500_000, 'manual'],
        ['2026-10-16', 'lawn', 130_000, 'manual'],
      ]);
      // A platform's own pulled rows alone: TikTok's source is not Meta's platform.
      await expect(
        admin.query(
          `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
           VALUES ($1, 'meta', '2026-10-13', 'X', 1, 'tiktok_api')`,
          [a.shopId],
        ),
      ).rejects.toThrow(/ad_spend_source_of_platform/);
    });

    it('keeps why a pull failed for the shop to see, trying again next time, and pulls now at most once a minute', async () => {
      unwrap(await accounts.connect(a, { advertiserId: ADVERTISER, accessToken: TOKEN }, NOW));
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
         VALUES ($1, 'tiktok', '2026-10-16', 'Lawn', 1000, 'tiktok_api')`,
        [a.shopId],
      );
      const later = new Date(NOW.getTime() + 3_600_000);
      pages = [{ status: 200, body: { code: 40102, message: 'Access token has expired' } }];
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'TikTok refused the token: Access token has expired',
      });
      expect(await accounts.get(a)).toMatchObject({
        lastSyncedAt: NOW,
        lastError: 'TikTok refused the token: Access token has expired',
      });
      // Nothing pulled is taken away for it.
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'tiktok_api']]);
      pages = [{ status: 200, body: { code: 51021, message: 'Rate limit' } }];
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'TikTok could not answer just now: Rate limit',
      });
      pages = [{ status: 500, body: { message: 'Internal error' } }];
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'TikTok could not answer just now: Internal error',
      });
      // More pages than a pull reads is not half a pull.
      pages = [
        {
          status: 200,
          body: report([['2026-10-16', 'Lawn', '1']], 1, TIKTOK_REPORT_PAGES + 1),
        },
      ];
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: `TikTok gave more than ${TIKTOK_REPORT_PAGES} pages of campaigns' days`,
      });
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'tiktok_api']]);
      expect(await accounts.get(a)).toMatchObject({ lastSyncedAt: NOW });

      // Pulled now: once a minute.
      pages = [{ status: 200, body: report([], 1, 0) }];
      const pulled = unwrap(await accounts.pull(a, new Date(later.getTime() + 60_000)));
      expect(pulled).toMatchObject({
        lastError: null,
        lastSyncedAt: new Date(later.getTime() + 60_000),
      });
      // TikTok reports nothing for the week now: what was pulled of it goes.
      expect(await rows()).toEqual([]);
      expect(await accounts.pull(a, new Date(later.getTime() + 90_000))).toMatchObject({
        ok: false,
        errors: [{ field: ['base'], code: 'INVALID' }],
      });
      expect(await accounts.pull(b, later)).toEqual({
        ok: false,
        errors: [
          {
            field: ['base'],
            code: 'NOT_FOUND',
            message: 'Connect a TikTok advertiser account first',
          },
        ],
      });

      // The worker's round: those asked longest ago first, or never.
      await admin.query(
        `INSERT INTO marketing.tiktok_ad_accounts
                (shop_id, advertiser_id, name, currency, access_token, token_hint)
         VALUES ($1, '7099999999', 'B', 'PKR', 'sealed', 'Zz99')`,
        [b.shopId],
      );
      expect(await accounts.dueShops(new Date(later.getTime() + 120_000))).toEqual([
        b.shopId,
        a.shopId,
      ]);
      expect(await accounts.dueShops(later)).toEqual([b.shopId]);
    });

    it('pulls another advertiser from its first 30 days, and another token at once', async () => {
      unwrap(await accounts.connect(a, { advertiserId: ADVERTISER, accessToken: TOKEN }, NOW));
      requests.splice(0);
      const later = new Date(NOW.getTime() + 86_400_000);
      unwrap(
        await accounts.connect(a, { advertiserId: ADVERTISER, accessToken: OTHER_TOKEN }, later),
      );
      expect(requests.at(-1)!.query.get('start_date')).toBe('2026-10-12');
      expect(requests.at(-1)!.token).toBe(OTHER_TOKEN);
      advertiser = {
        status: 200,
        body: {
          code: 0,
          data: { list: [{ advertiser_id: '70555', name: 'New', currency: 'PKR' }] },
        },
      };
      unwrap(await accounts.connect(a, { advertiserId: '70555', accessToken: OTHER_TOKEN }, later));
      expect(requests.at(-1)!.query.get('start_date')).toBe('2026-09-19');
      expect(requests.at(-1)!.query.get('end_date')).toBe('2026-10-18');
      expect(requests.at(-1)!.query.get('advertiser_id')).toBe('70555');
    });
  },
);

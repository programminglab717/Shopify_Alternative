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
import { META_INSIGHTS_PAGES, MetaAdsClient, adAccountIdOf, spendMinor } from './meta-ad-spend.js';
import { metaAdAccounts } from './schema.js';

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

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Ab12';
const OTHER_TOKEN = 'EAAGzzzzzzzzzzzzzzzzzzzzzz'.padEnd(60, 'z') + 'Cd34';

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

describe('Meta ad spend: reading what Meta writes (ADR-564)', () => {
  it('takes the ad account as Ads Manager shows it, or its digits', () => {
    expect(adAccountIdOf('act_123456789')).toBe('123456789');
    expect(adAccountIdOf(' ACT_1234 5678 ')).toBe('12345678');
    expect(adAccountIdOf('123456789')).toBe('123456789');
    expect(adAccountIdOf('act_12')).toBeNull();
    expect(adAccountIdOf('act_12345x')).toBeNull();
    expect(adAccountIdOf('')).toBeNull();
  });

  it("turns Meta's decimals into paisa, half a paisa up", () => {
    expect(spendMinor('1234.56', 2)).toBe(123_456n);
    expect(spendMinor('1234.5', 2)).toBe(123_450n);
    expect(spendMinor('1234', 2)).toBe(123_400n);
    expect(spendMinor('0.005', 2)).toBe(1n);
    expect(spendMinor('0.0049', 2)).toBe(0n);
    expect(spendMinor('19.995', 2)).toBe(2_000n);
    expect(spendMinor('0', 2)).toBe(0n);
    expect(spendMinor('-5', 2)).toBeNull();
    expect(spendMinor('1e3', 2)).toBeNull();
    expect(spendMinor('', 2)).toBeNull();
  });
});

describe.skipIf(!server)(
  "Meta ad spend: the shop's ad account, and its spend pulled (ADR-564)",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let graph: Server;
    let graphUrl: string;
    let accounts: MetaAdAccountService;
    let spend: AdSpendService;
    const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
    const a = tenant(newId());
    const b = tenant(newId());

    /** What the fake Graph API was asked, and what it answers. */
    const requests: { path: string; query: URLSearchParams; token: string | undefined }[] = [];
    let account: { status: number; body: unknown };
    /** The insights' pages, in turn; each page but the last links the next. */
    let pages: { status: number; body: unknown }[];

    const insights = (rows: [string, string, string][]) =>
      rows.map(([day, campaign_name, spend]) => ({
        campaign_name,
        spend,
        date_start: day,
        date_stop: day,
      }));

    const rows = async (shopId = a.shopId) =>
      (
        await admin.query<{ day: string; campaign: string; amount: string; source: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, campaign, amount::text AS amount, source
           FROM marketing.ad_spend WHERE shop_id = $1 AND platform = 'meta'
          ORDER BY day, campaign`,
          [shopId],
        )
      ).rows.map((row) => [row.day, row.campaign, Number(row.amount), row.source]);

    beforeAll(async () => {
      graph = createServer((request, response) => {
        const url = new URL(request.url ?? '/', graphUrl);
        requests.push({
          path: url.pathname,
          query: url.searchParams,
          token: request.headers.authorization?.replace(/^Bearer /, ''),
        });
        let answer = account;
        if (url.pathname.endsWith('/insights')) {
          const page = Number(url.searchParams.get('after') ?? 0);
          const each = pages[page] ?? { status: 200, body: { data: [] } };
          const next = new URL(url);
          next.searchParams.set('after', String(page + 1));
          answer =
            each.status === 200 && page + 1 < pages.length
              ? { ...each, body: { ...(each.body as object), paging: { next: next.href } } }
              : each;
        }
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
      await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
      graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'meta-ad-account-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
        a.shopId,
        b.shopId,
      ]);
      accounts = new MetaAdAccountService(
        db,
        box,
        new MetaAdsClient({ baseUrl: graphUrl, version: 'v26.0' }),
      );
      spend = new AdSpendService(db);
    });

    afterAll(async () => {
      await db?.close();
      await admin?.end();
      await testDb?.drop();
      await new Promise<void>((resolve) => (graph ? graph.close(() => resolve()) : resolve()));
    });

    beforeEach(async () => {
      await admin.query(
        'DELETE FROM marketing.meta_ad_accounts; DELETE FROM marketing.ad_spend; ' +
          'DELETE FROM platform.outbox_events; DELETE FROM platform.audit_log',
      );
      requests.splice(0);
      account = {
        status: 200,
        body: {
          id: 'act_123456789',
          name: 'Zari Ads',
          currency: 'PKR',
          timezone_name: 'Asia/Karachi',
          account_status: 1,
        },
      };
      pages = [{ status: 200, body: { data: [] } }];
    });

    it('matches the migrated tables', async () => {
      await db.tenant(a.shopId, (tx) => tx.select().from(metaAdAccounts).limit(1));
    });

    it('connects once Meta says the token reads an account billing in rupees, and pulls its last 30 days', async () => {
      expect(await accounts.get(a)).toBeNull();
      const wrong = await accounts.connect(a, { adAccountId: 'act_12', accessToken: 'short' }, NOW);
      expect(wrong.ok || wrong.errors.map((e) => [e.field.join('.'), e.code])).toEqual([
        ['input.adAccountId', 'INVALID'],
        ['input.accessToken', 'INVALID'],
      ]);
      expect(requests).toEqual([]);

      pages = [
        {
          status: 200,
          body: {
            data: insights([
              ['2026-09-18', 'Eid Sale', '1500.5'],
              ['2026-10-17', ' Lawn  ', '99.999'],
              // Nothing spent is no row; a day before the 30 is not the pull's.
              ['2026-10-16', 'Brand', '0.00'],
              ['2026-09-17', 'Eid Sale', '700'],
            ]),
          },
        },
      ];
      const connected = unwrap(
        await accounts.connect(
          a,
          { adAccountId: ' act_123456789 ', accessToken: ` ${TOKEN} ` },
          NOW,
        ),
      );
      expect(connected).toEqual({
        adAccountId: '123456789',
        name: 'Zari Ads',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        tokenHint: 'Ab12',
        lastSyncedAt: NOW,
        lastError: null,
        updatedAt: expect.any(Date),
      });
      const [asked, pulled] = requests.splice(0);
      expect(asked).toMatchObject({ path: '/v26.0/act_123456789', token: TOKEN });
      expect(asked!.query.get('fields')).toBe('name,currency,timezone_name,account_status');
      // The token goes in a header, never in the address.
      expect(pulled).toMatchObject({ path: '/v26.0/act_123456789/insights', token: TOKEN });
      expect(Object.fromEntries(pulled!.query)).toEqual({
        level: 'campaign',
        time_increment: '1',
        time_range: '{"since":"2026-09-18","until":"2026-10-17"}',
        fields: 'campaign_name,spend,date_start',
        limit: '500',
      });
      expect(await rows()).toEqual([
        ['2026-09-18', 'Eid Sale', 150_050, 'meta_api'],
        ['2026-10-17', 'Lawn', 10_000, 'meta_api'],
      ]);
      expect(unwrap(await spend.list(a, '2026-10-17', '2026-10-17'))).toEqual([
        {
          platform: 'meta',
          day: '2026-10-17',
          campaign: 'Lawn',
          amount: 10_000n,
          source: 'meta_api',
        },
      ]);

      // Kept sealed, for the shop alone; audited, the token never.
      const { rows: sealed } = await admin.query<{ access_token: string }>(
        'SELECT access_token FROM marketing.meta_ad_accounts',
      );
      expect(sealed[0]!.access_token).not.toContain(TOKEN.slice(0, 20));
      const { rows: audit } = await admin.query<{ action: string; details: string }>(
        'SELECT action, details::text FROM platform.audit_log ORDER BY id',
      );
      expect(audit.map((row) => row.action)).toEqual(['meta_ad_account.connected']);
      expect(audit[0]!.details).not.toContain(TOKEN.slice(0, 20));
      expect(JSON.parse(audit[0]!.details)).toMatchObject({
        changed: ['adAccountId', 'accessToken'],
        adAccountId: '123456789',
        tokenHint: 'Ab12',
        before: null,
      });
      const { rows: events } = await admin.query<{ event_type: string; payload: unknown }>(
        'SELECT event_type, payload FROM platform.outbox_events',
      );
      expect(events).toEqual([
        {
          event_type: 'meta_ad_account.connected',
          payload: expect.objectContaining({
            adAccountId: '123456789',
            changed: ['adAccountId', 'accessToken'],
          }),
        },
      ]);
      expect(await accounts.get(b)).toBeNull();

      // The same again changes nothing, and asks Meta only to check it.
      unwrap(await accounts.connect(a, { adAccountId: '123456789', accessToken: TOKEN }, NOW));
      expect(requests.splice(0).map((each) => each.path)).toEqual(['/v26.0/act_123456789']);
      expect((await admin.query('SELECT 1 FROM platform.audit_log')).rowCount).toBe(1);

      // Disconnecting forgets the token, and keeps the spend pulled.
      expect(await accounts.disconnect(a)).toBe('123456789');
      expect(await accounts.disconnect(a)).toBeNull();
      expect(await accounts.get(a)).toBeNull();
      expect(await rows()).toHaveLength(2);
      expect(await accounts.sync(a.shopId, NOW)).toBeNull();
      const { rows: last } = await admin.query<{ event_type: string }>(
        'SELECT event_type FROM platform.outbox_events ORDER BY id DESC LIMIT 1',
      );
      expect(last[0]!.event_type).toBe('meta_ad_account.disconnected');
    });

    it('refuses what Meta refuses, an account billing in another currency, and plans without true profit', async () => {
      const connect = async (service = accounts) => {
        const result = await service.connect(
          a,
          { adAccountId: '123456789', accessToken: TOKEN },
          NOW,
        );
        return result.ok ? result.value : result.errors;
      };
      account = {
        status: 400,
        body: {
          error: { code: 190, type: 'OAuthException', message: 'Error validating access token' },
        },
      };
      expect(await connect()).toEqual([
        {
          field: ['input', 'accessToken'],
          code: 'INVALID',
          message: 'Meta refused the token: Error validating access token',
        },
      ]);
      account = {
        status: 400,
        body: { error: { code: 100, message: "Object with ID 'act_123456789' does not exist" } },
      };
      expect(await connect()).toMatchObject([{ field: ['input', 'adAccountId'], code: 'INVALID' }]);
      account = {
        status: 400,
        body: { error: { code: 17, message: 'User request limit reached' } },
      };
      expect(await connect()).toMatchObject([
        { field: ['input', 'accessToken'], code: 'UNAVAILABLE' },
      ]);
      account = { status: 200, body: { name: 'Dollar Ads', currency: 'USD', account_status: 1 } };
      expect(await connect()).toEqual([
        {
          field: ['input', 'adAccountId'],
          code: 'INVALID',
          message: 'Hatti records ad spend in rupees: this ad account bills in USD',
        },
      ]);
      const starter = new MetaAdAccountService(
        db,
        box,
        new MetaAdsClient({ baseUrl: graphUrl, version: 'v26.0' }),
        new Starter(),
      );
      account = { status: 200, body: { name: 'Zari Ads', currency: 'PKR' } };
      expect(await connect(starter)).toEqual([
        {
          field: ['input'],
          code: 'INVALID',
          message:
            "The Starter plan doesn't include true profit: choose a bigger plan to connect Meta's ad spend",
        },
      ]);
      expect(await accounts.get(a)).toBeNull();
      // One connected before stays on the smaller plan, and may take another token there.
      expect(await connect()).toMatchObject({ adAccountId: '123456789', timezone: null });
      expect(
        unwrap(
          await starter.connect(a, { adAccountId: '123456789', accessToken: OTHER_TOKEN }, NOW),
        ).tokenHint,
      ).toBe('Cd34');
    });

    it("keeps what the shop typed, and puts Meta's last week in the place of what was pulled of it", async () => {
      unwrap(await accounts.connect(a, { adAccountId: '123456789', accessToken: TOKEN }, NOW));
      // Pulled before: Meta still reports one of these, and no longer the others.
      unwrap(
        await spend.set(
          a,
          [
            // Typed by hand: a campaign Meta reports, and Meta's whole day on another day.
            { platform: 'meta', day: '2026-10-15', campaign: 'EID SALE', amount: '5000' },
            { platform: 'meta', day: '2026-10-14', amount: '8000' },
            // Another platform is not Meta's to replace.
            { platform: 'tiktok', day: '2026-10-15', campaign: 'Eid Sale', amount: '100' },
          ],
          NOW,
        ),
      );
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
       VALUES ($1, 'meta', '2026-10-16', 'Lawn', 1000, 'meta_api'),
              ($1, 'meta', '2026-10-12', 'Gone', 1000, 'meta_api'),
              ($1, 'meta', '2026-10-10', 'Older', 1000, 'meta_api')`,
        [a.shopId],
      );
      pages = [
        {
          status: 200,
          body: {
            data: insights([
              ['2026-10-15', 'Eid Sale', '9999'],
              ['2026-10-15', 'Brand', '250'],
              ['2026-10-14', 'Brand', '300'],
              ['2026-10-16', 'Lawn', '1200.10'],
            ]),
          },
        },
        {
          status: 200,
          body: {
            data: insights([
              // The same campaign by another letter case, or twice, is added up.
              ['2026-10-16', 'lawn', '10'],
              ['2026-10-17', 'Lawn', '0'],
              ['2026-10-17', 'x'.repeat(250), '1'],
            ]),
          },
        },
      ];
      requests.splice(0);
      expect(await accounts.sync(a.shopId, new Date(NOW.getTime() + 3 * 3_600_000))).toEqual({
        ok: true,
        days: 7,
        entries: 3,
      });
      expect(requests.map((each) => each.query.get('after'))).toEqual([null, '1']);
      expect(requests[0]!.query.get('time_range')).toBe(
        '{"since":"2026-10-11","until":"2026-10-17"}',
      );
      expect(await rows()).toEqual([
        // Outside the week, kept as it was.
        ['2026-10-10', 'Older', 1000, 'meta_api'],
        // The shop's whole day keeps Meta's campaigns of it out.
        ['2026-10-14', '', 800_000, 'manual'],
        // The shop's campaign stays as typed; Meta's others come in.
        ['2026-10-15', 'Brand', 25_000, 'meta_api'],
        ['2026-10-15', 'EID SALE', 500_000, 'manual'],
        ['2026-10-16', 'Lawn', 121_010, 'meta_api'],
        ['2026-10-17', 'x'.repeat(200), 100, 'meta_api'],
      ]);
      const { rows: tiktok } = await admin.query(
        `SELECT 1 FROM marketing.ad_spend WHERE platform = 'tiktok'`,
      );
      expect(tiktok).toHaveLength(1);

      // Typed over, a pulled campaign's day is the shop's; Meta's whole day typed puts the
      // campaigns pulled for it away.
      unwrap(
        await spend.set(
          a,
          [
            { platform: 'meta', day: '2026-10-16', campaign: 'lawn', amount: '1300' },
            { platform: 'meta', day: '2026-10-15', amount: '7000' },
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
    });

    it('keeps why a pull failed for the shop to see, trying again next time, and pulls now at most once a minute', async () => {
      unwrap(await accounts.connect(a, { adAccountId: '123456789', accessToken: TOKEN }, NOW));
      await admin.query(
        `INSERT INTO marketing.ad_spend (shop_id, platform, day, campaign, amount, source)
       VALUES ($1, 'meta', '2026-10-16', 'Lawn', 1000, 'meta_api')`,
        [a.shopId],
      );
      const later = new Date(NOW.getTime() + 3_600_000);
      pages = [
        {
          status: 401,
          body: { error: { code: 190, type: 'OAuthException', message: 'Session has expired' } },
        },
      ];
      expect(await accounts.sync(a.shopId, later)).toEqual({
        ok: false,
        message: 'Meta refused the token: Session has expired',
      });
      expect(await accounts.get(a)).toMatchObject({
        lastSyncedAt: NOW,
        lastError: 'Meta refused the token: Session has expired',
      });
      // Nothing pulled is taken away for it.
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'meta_api']]);
      pages = [{ status: 400, body: { error: { code: 80000, message: 'Too many calls' } } }];
      expect(await accounts.sync(a.shopId, later)).toMatchObject({
        ok: false,
        message: 'Meta could not answer just now: Too many calls',
      });
      // More pages than a pull reads is not half a pull.
      pages = Array.from({ length: META_INSIGHTS_PAGES + 1 }, () => ({
        status: 200,
        body: { data: insights([['2026-10-16', 'Lawn', '1']]) },
      }));
      expect(await accounts.sync(a.shopId, later)).toMatchObject({ ok: false });
      expect(await rows()).toEqual([['2026-10-16', 'Lawn', 1000, 'meta_api']]);

      // Pulled now: once a minute.
      pages = [{ status: 200, body: { data: [] } }];
      const pulled = unwrap(await accounts.pull(a, new Date(later.getTime() + 60_000)));
      expect(pulled).toMatchObject({
        lastError: null,
        lastSyncedAt: new Date(later.getTime() + 60_000),
      });
      // Meta reports nothing for the week now: what was pulled of it goes.
      expect(await rows()).toEqual([]);
      expect(await accounts.pull(a, new Date(later.getTime() + 90_000))).toMatchObject({
        ok: false,
        errors: [{ field: ['base'], code: 'INVALID' }],
      });
      expect(await accounts.pull(b, later)).toMatchObject({
        ok: false,
        errors: [{ code: 'NOT_FOUND' }],
      });

      // The worker's round: those asked longest ago first, or never.
      await admin.query(
        `INSERT INTO marketing.meta_ad_accounts
      (shop_id, ad_account_id, name, currency, access_token, token_hint)
      VALUES ($1, '987654321', 'B', 'PKR', 'sealed', 'Zz99')`,
        [b.shopId],
      );
      expect(await accounts.dueShops(new Date(later.getTime() + 120_000))).toEqual([
        b.shopId,
        a.shopId,
      ]);
      expect(await accounts.dueShops(later)).toEqual([b.shopId]);
    });

    it('pulls another account from its first 30 days, and another token at once', async () => {
      unwrap(await accounts.connect(a, { adAccountId: '123456789', accessToken: TOKEN }, NOW));
      requests.splice(0);
      const later = new Date(NOW.getTime() + 86_400_000);
      unwrap(
        await accounts.connect(a, { adAccountId: '123456789', accessToken: OTHER_TOKEN }, later),
      );
      expect(requests.at(-1)!.query.get('time_range')).toBe(
        '{"since":"2026-10-12","until":"2026-10-18"}',
      );
      expect(requests.at(-1)!.token).toBe(OTHER_TOKEN);
      unwrap(
        await accounts.connect(a, { adAccountId: 'act_55555', accessToken: OTHER_TOKEN }, later),
      );
      expect(requests.at(-1)!.query.get('time_range')).toBe(
        '{"since":"2026-09-19","until":"2026-10-18"}',
      );
      expect(requests.at(-1)!.path).toBe('/v26.0/act_55555/insights');
    });
  },
);

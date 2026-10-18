import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MutationResult, TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import {
  MetaAdAccountService,
  MetaAdsClient,
  TikTokAdAccountService,
  TikTokAdsClient,
} from '@hatti/marketing/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdSpendSync } from './ad-spend-sync.js';

const server = testDatabaseServer();

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Ab12';

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
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

/** 17 October 2026, noon in Karachi. */
const NOW = new Date('2026-10-17T07:00:00Z');
const HOUR = 3_600_000;

describe.skipIf(!server)("Shops' ad spend pulled from Meta (ADR-564) and TikTok (ADR-566)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let graph: Server;
  let graphUrl: string;
  let accounts: MetaAdAccountService;
  let advertisers: TikTokAdAccountService;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const [a, b, c] = [tenant(newId()), tenant(newId()), tenant(newId())];
  /** The ad accounts the fake Graph API was asked the spend of, and TikTok's advertisers. */
  const asked: string[] = [];
  /** Accounts whose token Meta or TikTok refuses now. */
  const refused = new Set<string>();

  beforeAll(async () => {
    graph = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://graph');
      if (url.pathname.startsWith('/open_api/v1.3/')) {
        // TikTok's Business API.
        const advertiser =
          url.searchParams.get('advertiser_id') ??
          (JSON.parse(url.searchParams.get('advertiser_ids') ?? '[]') as string[])[0] ??
          '';
        let answer: unknown = {
          code: 0,
          data: { list: [{ advertiser_id: advertiser, name: 'TikTok', currency: 'PKR' }] },
        };
        if (url.pathname.endsWith('/report/integrated/get/')) {
          asked.push(`tiktok:${advertiser}`);
          answer = refused.has(advertiser)
            ? { code: 40105, message: 'The access token is invalid' }
            : {
                code: 0,
                data: {
                  list: [
                    {
                      dimensions: { campaign_id: '1', stat_time_day: '2026-10-16 00:00:00' },
                      metrics: { spend: '700.50', campaign_name: 'Lawn' },
                    },
                  ],
                  page_info: { page: 1, total_page: 1 },
                },
              };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
        return;
      }
      const id = /act_(\d+)/.exec(url.pathname)?.[1] ?? '';
      let body: unknown = { name: `Ads ${id}`, currency: 'PKR', timezone_name: 'Asia/Karachi' };
      let status = 200;
      if (url.pathname.endsWith('/insights')) {
        asked.push(id);
        body = {
          data: [{ campaign_name: 'Lawn', spend: '1500.25', date_start: '2026-10-16' }],
        };
        if (refused.has(id)) {
          status = 400;
          body = { error: { code: 190, type: 'OAuthException', message: 'Session has expired' } };
        }
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
    graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'ad-spend-sync-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B'), ($3, 'C')`,
      [a.shopId, b.shopId, c.shopId],
    );
    accounts = new MetaAdAccountService(
      database,
      box,
      new MetaAdsClient({ baseUrl: graphUrl, version: 'v26.0' }),
    );
    advertisers = new TikTokAdAccountService(
      database,
      box,
      new TikTokAdsClient({ baseUrl: graphUrl }),
    );
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
    await new Promise<void>((resolve) => (graph ? graph.close(() => resolve()) : resolve()));
  });

  it("pulls every connected shop's last week each round, one Meta refuses or one failing not stopping the others", async () => {
    unwrap(await accounts.connect(a, { adAccountId: '11111', accessToken: TOKEN }, NOW));
    unwrap(await accounts.connect(b, { adAccountId: '22222', accessToken: TOKEN }, NOW));
    // A token sealed with keys the worker no longer has cannot be opened: that shop alone fails.
    await admin.query(
      `INSERT INTO marketing.meta_ad_accounts
              (shop_id, ad_account_id, name, currency, access_token, token_hint)
       VALUES ($1, '33333', 'C', 'PKR', 'not-sealed', 'Zz99')`,
      [c.shopId],
    );
    expect(asked.splice(0)).toEqual(['11111', '22222']);
    await admin.query('DELETE FROM marketing.ad_spend');

    refused.add('22222');
    const sync = new AdSpendSync({ meta: accounts });
    // The shop never pulled goes first; those just pulled wait for their turn.
    expect(await sync.sweep(new Date(NOW.getTime() + 3 * HOUR), 4 * HOUR)).toBe(0);
    expect(asked.splice(0)).toEqual([]);
    expect(await sync.sweep(new Date(NOW.getTime() + 3 * HOUR), HOUR)).toBe(1);
    expect(asked.splice(0)).toEqual(['11111', '22222']);

    const { rows } = await admin.query<{ shop_id: string; day: string; amount: string }>(
      `SELECT shop_id, to_char(day, 'YYYY-MM-DD') AS day, amount::text AS amount
         FROM marketing.ad_spend WHERE source = 'meta_api'`,
    );
    expect(rows).toEqual([{ shop_id: a.shopId, day: '2026-10-16', amount: '150025' }]);
    expect(await accounts.get(b)).toMatchObject({
      lastError: 'Meta refused the token: Session has expired',
    });
    // Tried again the next round, and through once Meta takes it.
    refused.clear();
    expect(await sync.sweep(new Date(NOW.getTime() + 6 * HOUR))).toBe(2);
    expect(asked.splice(0)).toEqual(['11111', '22222']);
    expect(await accounts.get(b)).toMatchObject({ lastError: null });
  });

  it("pulls TikTok's advertisers in the same rounds as Meta's ad accounts, each longest ago first", async () => {
    await admin.query('DELETE FROM marketing.meta_ad_accounts; DELETE FROM marketing.ad_spend');
    refused.clear();
    const sync = new AdSpendSync({ meta: accounts, tiktok: advertisers });
    unwrap(await accounts.connect(a, { adAccountId: '11111', accessToken: TOKEN }, NOW));
    unwrap(await advertisers.connect(a, { advertiserId: '7000000001', accessToken: TOKEN }, NOW));
    unwrap(await advertisers.connect(b, { advertiserId: '7000000002', accessToken: TOKEN }, NOW));
    // Sealed with keys the worker no longer has: that shop alone fails.
    await admin.query(
      `INSERT INTO marketing.tiktok_ad_accounts
              (shop_id, advertiser_id, name, currency, access_token, token_hint)
       VALUES ($1, '7000000003', 'C', 'PKR', 'not-sealed', 'Zz99')`,
      [c.shopId],
    );
    // B's pulled first, longer ago than A's.
    await admin.query(
      `UPDATE marketing.tiktok_ad_accounts SET last_attempt_at = $2 WHERE shop_id = $1`,
      [b.shopId, new Date(NOW.getTime() - HOUR)],
    );
    expect(asked.splice(0)).toEqual(['11111', 'tiktok:7000000001', 'tiktok:7000000002']);
    await admin.query('DELETE FROM marketing.ad_spend');

    refused.add('7000000001');
    expect(await sync.sweep(new Date(NOW.getTime() + 3 * HOUR), HOUR)).toBe(2);
    expect(asked.splice(0)).toEqual(['11111', 'tiktok:7000000002', 'tiktok:7000000001']);
    const { rows } = await admin.query<{ shop_id: string; platform: string; amount: string }>(
      `SELECT shop_id, platform, amount::text AS amount FROM marketing.ad_spend
        WHERE source <> 'manual' ORDER BY platform`,
    );
    expect(rows).toEqual([
      { shop_id: a.shopId, platform: 'meta', amount: '150025' },
      { shop_id: b.shopId, platform: 'tiktok', amount: '70050' },
    ]);
    expect(await advertisers.get(a)).toMatchObject({
      lastError: 'TikTok refused the token: The access token is invalid',
    });
    // Tried again the next round, and through once TikTok takes it.
    refused.clear();
    expect(await sync.sweep(new Date(NOW.getTime() + 6 * HOUR))).toBe(3);
    expect(await advertisers.get(a)).toMatchObject({ lastError: null });
  });
});

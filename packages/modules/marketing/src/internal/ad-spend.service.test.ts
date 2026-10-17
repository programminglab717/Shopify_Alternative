import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdSpendService, adSpendByCampaignIn, adSpendByPeriodIn } from './ad-spend.service.js';

const server = testDatabaseServer();

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

const NOW = new Date('2026-10-17T12:00:00Z');

describe.skipIf(!server)("A shop's ad spend (MKT-12, ADR-553)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let spend: AdSpendService;
  const a = tenant(newId());
  const b = tenant(newId());

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'ad-spend-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    spend = new AdSpendService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM marketing.ad_spend');
  });

  it('keeps each day by platform and campaign, replaced when given again, and gone at 0', async () => {
    expect(
      unwrap(
        await spend.set(
          a,
          [
            { platform: 'meta', day: '2026-10-15', amount: '1,500' },
            { platform: 'meta', day: '2026-10-15', campaign: ' Eid-Sale ', amount: '2000.50' },
            { platform: 'google', day: '2026-10-16', campaign: 'Brand', amount: '300' },
            { platform: 'tiktok', day: '2026-10-16', amount: '0' },
          ],
          NOW,
        ),
      ),
    ).toBe(4);
    // The campaign in another case is the same one; 0 takes Google's day away.
    unwrap(
      await spend.set(
        a,
        [
          { platform: 'meta', day: '2026-10-15', campaign: 'eid-sale', amount: '2500' },
          { platform: 'google', day: '2026-10-16', campaign: 'BRAND', amount: '' + 0 },
        ],
        NOW,
      ),
    );
    unwrap(await spend.set(b, [{ platform: 'meta', day: '2026-10-15', amount: '99' }], NOW));
    expect(unwrap(await spend.list(a, '2026-10-01', '2026-10-31'))).toEqual([
      { platform: 'meta', day: '2026-10-15', campaign: null, amount: 1_500_00n },
      { platform: 'meta', day: '2026-10-15', campaign: 'eid-sale', amount: 2_500_00n },
    ]);
    expect(unwrap(await spend.list(a, '2026-10-16', '2026-10-31'))).toEqual([]);
  });

  it('says what is wrong with each, and keeps none of them then', async () => {
    const result = await spend.set(
      a,
      [
        { platform: 'meta', day: '2026-10-15', amount: '500' },
        { platform: 'snapchat' as 'meta', day: '2026-10-15', amount: '1' },
        { platform: 'meta', day: '2026-02-30', amount: '1' },
        { platform: 'meta', day: '2026-10-19', amount: '1' },
        { platform: 'google', day: '2026-10-15', amount: '-5' },
        { platform: 'tiktok', day: '2026-10-15', campaign: 'x'.repeat(201), amount: '5' },
        { platform: 'other', day: '2026-10-15', amount: '2000000000' },
      ],
      NOW,
    );
    expect(
      result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.code]),
    ).toEqual([
      ['entries.1.platform', 'INVALID'],
      ['entries.2.day', 'INVALID'],
      ['entries.3.day', 'INVALID'],
      ['entries.4.amount', 'INVALID'],
      ['entries.5.campaign', 'TOO_LONG'],
      ['entries.6.amount', 'INVALID'],
    ]);
    expect(unwrap(await spend.list(a, '2026-10-01', '2026-10-31'))).toEqual([]);
    // Tomorrow anywhere is still allowed; none at all, or too many, are not.
    unwrap(await spend.set(a, [{ platform: 'meta', day: '2026-10-18', amount: '1' }], NOW));
    expect(await spend.set(a, [], NOW)).toMatchObject({ ok: false });
    const many = Array.from({ length: 401 }, () => ({
      platform: 'meta' as const,
      day: '2026-10-15',
      amount: '1',
    }));
    expect(await spend.set(a, many, NOW)).toMatchObject({ ok: false });
    expect(await spend.list(a, '2026-10-31', '2026-10-01')).toMatchObject({ ok: false });
    expect(await spend.list(a, '2025-01-01', '2026-10-01')).toMatchObject({ ok: false });
  });

  it("adds the days up by the shop's periods, and by campaign, for the sales report", async () => {
    unwrap(
      await spend.set(
        a,
        [
          { platform: 'meta', day: '2026-09-29', campaign: 'Eid-Sale', amount: '1000' },
          { platform: 'tiktok', day: '2026-09-29', campaign: 'eid-sale', amount: '200' },
          { platform: 'meta', day: '2026-09-30', amount: '300' },
          { platform: 'meta', day: '2026-10-01', amount: '9999' },
        ],
        NOW,
      ),
    );
    const period = {
      placedFrom: new Date('2026-09-28T00:00:00+05:00'),
      placedBefore: new Date('2026-10-01T00:00:00+05:00'),
    };
    const byDay = await db.tenant(a.shopId, (tx) =>
      adSpendByPeriodIn(tx, a.shopId, 'Asia/Karachi', { ...period, interval: 'day' }),
    );
    expect(
      byDay
        .map((each) => [each.start.toISOString(), each.amount])
        .sort(([x], [y]) => String(x).localeCompare(String(y))),
    ).toEqual([
      ['2026-09-28T19:00:00.000Z', 1_200_00n],
      ['2026-09-29T19:00:00.000Z', 300_00n],
    ]);
    const byCampaign = await db.tenant(a.shopId, (tx) =>
      adSpendByCampaignIn(tx, a.shopId, 'Asia/Karachi', period),
    );
    expect([...byCampaign]).toEqual([['eid-sale', { title: 'Eid-Sale', amount: 1_200_00n }]]);
  });
});

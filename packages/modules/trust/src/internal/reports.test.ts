import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportsService } from './reports.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-16T08:00:00.000Z');

describe.skipIf(!server)('Reports of stores (TNS-01, ADR-460)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let reports: ReportsService;
  const zari = newId();
  const other = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'reports-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'B', 'b')`,
      [zari, other],
    );
    reports = new ReportsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('takes a report, due in 48 hours, refuses one without its reason or words, and one address past three a day', async () => {
    const bad = await reports.report(zari, { reason: 'rude', details: ' ', phone: '12345' }, NOW);
    expect(bad.ok || bad.errors.map((error) => [error.field[0], error.code])).toEqual([
      ['reason', 'INVALID'],
      ['details', 'BLANK'],
      ['phone', 'INVALID'],
    ]);
    const taken = await reports.report(
      zari,
      {
        reason: 'never_delivered',
        details: 'Paid Rs 4,500 by transfer on 2 Oct; nothing came and they stopped answering.',
        phone: '0300 1234567',
        orderName: '#1043',
        pageUrl: 'https://zari.hatti.pk/products/lawn',
        client: '203.0.113.9',
        language: 'ur',
      },
      NOW,
    );
    expect(taken.ok).toBe(true);
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT phone, order_name, status, due_at, client_hash, language FROM trust.reports`,
    );
    expect(rows).toEqual([
      {
        phone: '+923001234567',
        order_name: '#1043',
        status: 'open',
        due_at: new Date('2026-10-18T08:00:00.000Z'),
        client_hash: expect.stringMatching(/^[0-9a-f]{32}$/),
        language: 'ur',
      },
    ]);
    // The address is kept only as a hash with the shop's.
    expect(JSON.stringify(rows)).not.toContain('203.0.113.9');

    for (let i = 0; i < 2; i++) {
      expect(
        (
          await reports.report(
            zari,
            { reason: 'scam', details: 'Again', client: '203.0.113.9' },
            NOW,
          )
        ).ok,
      ).toBe(true);
    }
    const fourth = await reports.report(
      zari,
      { reason: 'scam', details: 'Again', client: '203.0.113.9' },
      NOW,
    );
    expect(fourth.ok || fourth.errors[0]!.message).toBe(
      'You have reported this store today already: Hatti is looking into it',
    );
    // Another store, or the next day, is taken.
    expect(
      (await reports.report(other, { reason: 'other', details: 'Hm', client: '203.0.113.9' }, NOW))
        .ok,
    ).toBe(true);
    const tomorrow = new Date(NOW.getTime() + 86_400_000 + 1000);
    expect(
      (
        await reports.report(
          zari,
          { reason: 'scam', details: 'Again', client: '203.0.113.9' },
          tomorrow,
        )
      ).ok,
    ).toBe(true);
    // No such store.
    expect((await reports.report(newId(), { reason: 'scam', details: 'x' }, NOW)).ok).toBe(false);
  });

  it("lists what is open for Hatti's people, the soonest due first, and decides each once", async () => {
    const open = await reports.list();
    expect(open.map((each) => [each.shopHandle, each.dueAt.toISOString()])).toEqual([
      ['zari', '2026-10-18T08:00:00.000Z'],
      ['zari', '2026-10-18T08:00:00.000Z'],
      ['zari', '2026-10-18T08:00:00.000Z'],
      ['b', '2026-10-18T08:00:00.000Z'],
      ['zari', '2026-10-19T08:00:01.000Z'],
    ]);
    expect(open[0]).toMatchObject({ shopName: 'Zari', openOfShop: 4, status: 'open' });
    const first = open.find((each) => each.reason === 'never_delivered')!;
    const decided = await reports.decide(
      first.id,
      { status: 'upheld', by: 'Ayesha', note: 'Warned the store; it refunded the shopper.' },
      NOW,
    );
    expect(decided).toMatchObject({
      status: 'upheld',
      decidedBy: 'Ayesha',
      decision: 'Warned the store; it refunded the shopper.',
      decidedAt: NOW,
      openOfShop: 3,
    });
    expect(await reports.decide(first.id, { status: 'dismissed', by: 'B', note: 'x' })).toBe(
      'decided',
    );
    expect(await reports.decide(newId(), { status: 'dismissed', by: 'B', note: 'x' })).toBe(
      'not_found',
    );
    expect(await reports.decide('nope', { status: 'dismissed', by: 'B', note: 'x' })).toBe(
      'not_found',
    );
    expect((await reports.list()).length).toBe(4);
    expect((await reports.list({ all: true })).length).toBe(5);
    // A shop's own login sees no other shop's reports.
    const seen = await db.tenant(other, (tx) =>
      tx.execute<{ count: number }>(`SELECT count(*)::int AS count FROM trust.reports` as never),
    );
    expect(seen.rows[0]!.count).toBe(1);
  });
});

import 'reflect-metadata';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TakedownsService, TrustEvents } from './takedowns.service.js';

const server = testDatabaseServer();
const NOW = new Date('2026-10-16T08:00:00.000Z');

describe.skipIf(!server)('Stores taken down (TNS-01, ADR-461)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let takedowns: TakedownsService;
  const zari = newId();
  const closed = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'takedowns-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, status, closed_at)
       VALUES ($1, 'Zari', 'zari', 'active', NULL), ($2, 'Gone', 'gone', 'closed', now())`,
      [zari, closed],
    );
    takedowns = new TakedownsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  const statusOf = async (shopId: string) =>
    (
      await admin.query<{ status: string }>(`SELECT status FROM control.shops WHERE id = $1`, [
        shopId,
      ])
    ).rows[0]!.status;
  const events = async () =>
    (
      await admin.query<{ event_type: string }>(
        `SELECT event_type FROM platform.outbox_events WHERE shop_id = $1 ORDER BY occurred_at, id`,
        [zari],
      )
    ).rows.map((row) => row.event_type);

  it('suspends an active store by its handle, once, and restores it, each kept with who and why', async () => {
    const taken = await takedowns.suspend(
      ' Zari ',
      { reason: 'scam', note: 'Advances taken for orders never sent, 6 reports', by: 'Ayesha' },
      NOW,
    );
    expect(taken).toMatchObject({
      shopId: zari,
      shopName: 'Zari',
      reason: 'scam',
      note: 'Advances taken for orders never sent, 6 reports',
      takenBy: 'Ayesha',
      createdAt: NOW,
      restoredAt: null,
    });
    expect(await statusOf(zari)).toBe('suspended');
    expect(await takedowns.shop(zari)).toMatchObject({ handle: 'zari', status: 'suspended' });
    // Down once at a time; nothing else is taken down, and nothing unknown.
    const again = { reason: 'scam', note: 'Again', by: 'Ayesha' };
    expect(await takedowns.suspend('zari', again, NOW)).toBe('not_active');
    expect(await takedowns.suspend('gone', again, NOW)).toBe('not_active');
    expect(await takedowns.suspend('nobody', again, NOW)).toBe('not_found');
    await expect(takedowns.suspend('zari', { ...again, reason: 'rude' })).rejects.toThrow(
      RangeError,
    );
    await expect(takedowns.suspend('zari', { ...again, note: ' ' })).rejects.toThrow(RangeError);
    expect((await takedowns.list()).map((takedown) => takedown.shopHandle)).toEqual(['zari']);

    const later = new Date(NOW.getTime() + 86_400_000);
    const restored = await takedowns.restore(
      zari,
      { note: 'Refunded every advance; owner verified', by: 'Bilal' },
      later,
    );
    expect(restored).toMatchObject({
      restoredAt: later,
      restoredBy: 'Bilal',
      restoreNote: 'Refunded every advance; owner verified',
    });
    expect(await statusOf(zari)).toBe('active');
    expect(await takedowns.restore('zari', { note: 'Again', by: 'Bilal' })).toBe('not_suspended');
    expect(await takedowns.restore('gone', { note: 'Again', by: 'Bilal' })).toBe('not_suspended');
    expect(await takedowns.list()).toEqual([]);
    expect(await takedowns.list({ all: true })).toHaveLength(1);
    expect(await events()).toEqual([TrustEvents.StoreSuspended, TrustEvents.StoreRestored]);
  });
});

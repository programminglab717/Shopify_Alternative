import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_KEPT_DAYS, purgePublishedEvents } from './index.js';

const server = testDatabaseServer();
const DAY_MS = 86_400_000;

describe.skipIf(!server)('Published events kept seven days (ADR-746)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  const now = new Date('2026-10-23T10:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

  /** An event of `occurred` days ago, published `published` days ago or never. */
  const event = async (occurred: number, published: number | null, attempts = 1) => {
    const id = newId();
    await admin.query(
      `INSERT INTO platform.outbox_events
         (id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at,
          published_at, attempts)
       VALUES ($1, $2, 'order', $3, 'order.created', '{}', $4, $5, $6)`,
      [
        id,
        newId(),
        newId(),
        daysAgo(occurred),
        published === null ? null : daysAgo(published),
        attempts,
      ],
    );
    return id;
  };
  const left = async () =>
    (await admin.query<{ id: string }>('SELECT id FROM platform.outbox_events')).rows
      .map((row) => row.id)
      .sort();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, systemUrl: testDb.systemUrl, applicationName: 't' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('deletes events published before the cut-off, the oldest first, never one not yet published', async () => {
    await event(30, 30);
    const older = await event(9, 8);
    const recent = await event(8, 6);
    const waiting = await event(1, null);
    // Parked after its attempts, a month ago: kept for someone to look at.
    const parked = await event(30, null, 10);
    const before = new Date(now.getTime() - OUTBOX_KEPT_DAYS * DAY_MS);

    expect(await purgePublishedEvents(db.systemDb, before, 1)).toBe(1);
    expect(await left()).toEqual([older, recent, waiting, parked].sort());
    expect(await purgePublishedEvents(db.systemDb, before, 100)).toBe(1);
    expect(await purgePublishedEvents(db.systemDb, before, 100)).toBe(0);
    expect(await left()).toEqual([recent, waiting, parked].sort());
  });
});

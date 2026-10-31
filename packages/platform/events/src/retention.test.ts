import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_KEPT_DAYS, maintainOutboxPartitions, purgePublishedEvents } from './index.js';

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

  it('keeps the outbox in daily partitions, a week made ahead, past days dropped whole unless kept (ADR-988)', async () => {
    await admin.query('DELETE FROM platform.outbox_events');
    // A day long before the migration's partitions, made around the day it ran.
    const at = new Date('2025-06-15T10:00:00Z');
    const on = async (occurred: number, published: number | null) => {
      const id = newId();
      const day = (days: number) => new Date(at.getTime() - days * DAY_MS);
      await admin.query(
        `INSERT INTO platform.outbox_events
           (id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at,
            published_at, attempts)
         VALUES ($1, $2, 'order', $3, 'order.created', '{}', $4, $5, 1)`,
        [id, newId(), newId(), day(occurred), published === null ? null : day(published)],
      );
      return id;
    };
    const partitions = async () =>
      (
        await admin.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'platform.outbox_events'::regclass ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
    const partitionOf = async (id: string) =>
      (
        await admin.query<{ name: string }>(
          'SELECT tableoid::regclass::text AS name FROM platform.outbox_events WHERE id = $1',
          [id],
        )
      ).rows[0]?.name;
    // Events of days with no partition yet, the default holding them.
    const today = await on(0, null);
    const old = await on(12, 11);
    const oldKept = await on(11, null);
    const lateOne = await on(10, 1);
    expect(await partitionOf(today)).toBe('platform.outbox_events_default');

    // The default's days given partitions of their own, as the worker would when a day came:
    // made, and what the default held of them moved into them.
    await admin.query(`SELECT platform.outbox_make_partitions('2025-06-03', 3)`);
    expect(await partitionOf(old)).toBe('platform.outbox_events_p20250603');
    expect(await partitionOf(oldKept)).toBe('platform.outbox_events_p20250604');
    expect(await partitionOf(lateOne)).toBe('platform.outbox_events_p20250605');

    const before = new Date(at.getTime() - OUTBOX_KEPT_DAYS * DAY_MS);
    const kept = await maintainOutboxPartitions(db.systemDb, at, before);
    // Today's and the week ahead made, today's event moved into its day.
    expect(kept.made).toBe(8);
    expect(await partitionOf(today)).toBe('platform.outbox_events_p20250615');
    const made = await partitions();
    expect(made).toContain('outbox_events_p20250622');
    expect(made).not.toContain('outbox_events_p20250623');
    // The day all published before the cut-off dropped whole; one waiting, and one published
    // since the cut-off, kept.
    expect(kept.dropped).toBe(1);
    expect(made).not.toContain('outbox_events_p20250603');
    expect(made).toContain('outbox_events_p20250604');
    expect(made).toContain('outbox_events_p20250605');
    expect(await left()).toEqual([today, oldKept, lateOne].sort());
    // Again, nothing more to do.
    expect(await maintainOutboxPartitions(db.systemDb, at, before)).toEqual({
      made: 0,
      dropped: 0,
    });

    // The app's role still appends through the parent alone, and reads no partition.
    const app = new pg.Client({ connectionString: testDb.appUrl });
    await app.connect();
    try {
      await expect(app.query('SELECT 1 FROM platform.outbox_events_p20250615')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });
});

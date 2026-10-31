import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';

/**
 * Days a published event is kept in the outbox (ADR-746, 03 §6.5): long enough to look into what
 * was published lately, while nothing reads it again once its consumers have had it. An event
 * not yet published, or parked after its attempts, is kept however old, for someone to look at.
 */
export const OUTBOX_KEPT_DAYS = 7;

/**
 * Deletes up to `limit` events published before `before`, the oldest first, and says how many:
 * those another sweep holds are passed over, so two sweeps never wait on each other.
 */
export async function purgePublishedEvents(db: Db, before: Date, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM platform.outbox_events
     WHERE id IN (
       SELECT id FROM platform.outbox_events
        WHERE published_at < ${before}
        ORDER BY published_at
        LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
     )`);
  return result.rowCount ?? 0;
}

/** Days ahead the outbox's daily partitions are made (ADR-988), so a day never waits for one. */
export const OUTBOX_PARTITION_DAYS_AHEAD = 7;

/**
 * Keeps the outbox's daily partitions (ADR-988): those of the UTC days from `at`'s to a week on
 * made, each taking what the default partition holds of its day, and those of days ended by
 * `before` dropped, unless one of their events is unpublished or published since. Says how many
 * it made and dropped.
 */
export async function maintainOutboxPartitions(
  db: Db,
  at: Date,
  before: Date,
): Promise<{ made: number; dropped: number }> {
  const { rows } = await db.execute<{ made: number; dropped: number }>(sql`
    SELECT platform.outbox_make_partitions(
             (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date,
             ${OUTBOX_PARTITION_DAYS_AHEAD + 1}) AS made,
           platform.outbox_drop_partitions(${before.toISOString()}::timestamptz) AS dropped`);
  return { made: Number(rows[0]?.made ?? 0), dropped: Number(rows[0]?.dropped ?? 0) };
}

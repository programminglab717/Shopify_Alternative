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

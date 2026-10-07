import { AsyncLocalStorage } from 'node:async_hooks';
import { toDate, type Tx } from '@hatti/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Who makes what a request records (ADM-04, ADR-256): a member of staff, with their role then,
 * or an app, by its access token, as the Admin API knew them. Every event appended while one is
 * set is on the shop's activity log too, by them.
 */
export interface EventActor {
  kind: 'app' | 'staff';
  /** The member of staff, or the app's access token. */
  id: string;
  /** A member of staff's role at the time; null for an app. */
  role: string | null;
}

const actors = new AsyncLocalStorage<EventActor>();

/** Runs `fn` with `actor` making what it records; with none, as it would run anyway. */
export function actingAs<T>(actor: EventActor | null, fn: () => T): T {
  return actor ? actors.run(actor, fn) : fn();
}

/** Who makes what is recorded now, where a request said; null for the worker and the rest. */
export function currentActor(): EventActor | null {
  return actors.getStore() ?? null;
}

/** A change the shop's staff or apps made, as the event it recorded: never what it recorded. */
export interface ActivityEntry {
  /** The event's. */
  id: string;
  /** "product.updated". */
  type: string;
  /** What it happened to, as the event names it: "product", "billing_invoice". */
  aggregateType: string;
  aggregateId: string;
  actor: EventActor;
  occurredAt: Date;
}

export interface ActivityQuery {
  first: number;
  /** An entry's ID: entries older than it. */
  after?: string | null;
  /** What it happened to. */
  aggregateId?: string | null;
  type?: string | null;
}

/** What the shop's staff and apps changed, the latest first. */
export async function listActivity(
  tx: Tx,
  shopId: string,
  query: ActivityQuery,
): Promise<{ items: ActivityEntry[]; hasNextPage: boolean }> {
  const conditions: SQL[] = [sql`shop_id = ${shopId}`];
  if (query.after) conditions.push(sql`id < ${query.after}`);
  if (query.aggregateId) conditions.push(sql`aggregate_id = ${query.aggregateId}`);
  if (query.type) conditions.push(sql`event_type = ${query.type}`);
  const { rows } = await tx.execute<{
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    actor_kind: 'app' | 'staff';
    actor_id: string;
    actor_role: string | null;
    occurred_at: string | Date;
  }>(sql`
    SELECT id, event_type, aggregate_type, aggregate_id, actor_kind, actor_id, actor_role,
           occurred_at
      FROM platform.activity_log
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY id DESC
     LIMIT ${query.first + 1}`);
  return {
    items: rows.slice(0, query.first).map((row) => ({
      id: row.id,
      type: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      actor: { kind: row.actor_kind, id: row.actor_id, role: row.actor_role },
      occurredAt: toDate(row.occurred_at),
    })),
    hasNextPage: rows.length > query.first,
  };
}

import { toDate, type Tx } from '@hatti/db';
import { newId, type IdKind } from '@hatti/ids';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Something a staff member or an app did that the shop may need to account for later, such as
 * revealing a customer's number or exporting customers; or what Hatti's support looked at
 * (ADR-156).
 */
export interface NewAuditEntry {
  /** "subject.verb", e.g. "customer.phone_revealed". */
  action: string;
  /** What it was done to, as a kind of public ID: "customer", "order", "shop". */
  subjectType: IdKind;
  subjectId: string;
  actorKind: 'app' | 'staff' | 'support';
  /** The access token, the staff member, or Hatti's support agent. */
  actorId: string;
  /** The staff member's role at the time; null for apps and support. */
  actorRole: string | null;
  /** More about it. Never contact details. */
  details?: Record<string, unknown>;
}

export interface AuditEntry extends Required<NewAuditEntry> {
  id: string;
  occurredAt: Date;
}

/**
 * Records an entry in the caller's transaction, so it stands if and only if what it describes
 * does. The log is append-only for request code.
 */
export async function recordAudit(tx: Tx, shopId: string, entry: NewAuditEntry): Promise<void> {
  await tx.execute(sql`
    INSERT INTO platform.audit_log
      (shop_id, id, action, subject_type, subject_id, actor_kind, actor_id, actor_role, details)
    VALUES (${shopId}, ${newId()}, ${entry.action}, ${entry.subjectType}, ${entry.subjectId},
            ${entry.actorKind}, ${entry.actorId}, ${entry.actorRole},
            ${JSON.stringify(entry.details ?? {})}::jsonb)`);
}

export interface AuditQuery {
  first: number;
  /** An entry's ID: entries older than it. */
  after?: string | null;
  subjectId?: string | null;
  action?: string | null;
}

/** The shop's audit log, newest first. */
export async function listAudit(
  tx: Tx,
  shopId: string,
  query: AuditQuery,
): Promise<{ items: AuditEntry[]; hasNextPage: boolean }> {
  const conditions: SQL[] = [sql`shop_id = ${shopId}`];
  if (query.after) conditions.push(sql`id < ${query.after}`);
  if (query.subjectId) conditions.push(sql`subject_id = ${query.subjectId}`);
  if (query.action) conditions.push(sql`action = ${query.action}`);
  const { rows } = await tx.execute<{
    id: string;
    action: string;
    subject_type: IdKind;
    subject_id: string;
    actor_kind: 'app' | 'staff' | 'support';
    actor_id: string;
    actor_role: string | null;
    details: Record<string, unknown>;
    occurred_at: string;
  }>(sql`
    SELECT id, action, subject_type, subject_id, actor_kind, actor_id, actor_role, details,
           occurred_at
      FROM platform.audit_log
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY id DESC
     LIMIT ${query.first + 1}`);
  return {
    items: rows.slice(0, query.first).map((row) => ({
      id: row.id,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      actorKind: row.actor_kind,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      details: row.details,
      occurredAt: toDate(row.occurred_at),
    })),
    hasNextPage: rows.length > query.first,
  };
}

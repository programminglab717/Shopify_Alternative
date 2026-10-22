import { Database } from '@hatti/db';
import { sql, type SQL } from 'drizzle-orm';

/** How long what messages said is kept: Hatti's privacy policy promises twelve months (ADR-738). */
export const MESSAGE_CONTENT_KEPT = '12 months';

/** Rows of each kind found past their twelve months at a time, across shops. */
export const RETENTION_BATCH = 1_000;

/**
 * How many of each a purge cleared or deleted: `messages` to customers whose variables and error
 * it cleared; `conversationMessages` and `contactMessages` it deleted, and `conversations` it
 * deleted as nothing was left in them.
 */
export interface PurgedCounts {
  messages: number;
  conversationMessages: number;
  conversations: number;
  contactMessages: number;
}

/**
 * What messages said, kept twelve months and no longer (ADR-738), as Hatti's privacy policy and
 * data processing agreement say (ADR-736). A message to a customer keeps that it was sent, to whom,
 * by which channel and when, and how it went, which the shop's bills and the customer's history
 * count; what it said, its template's variables, and the error its provider gave are cleared. What
 * customers wrote, in the inbox and through the contact form, is deleted, and a conversation with
 * nothing left in it goes too. The worker's sweep does it across shops, found with the system role
 * and each shop's changed in its own transaction, as carts past their time are (ADR-230).
 */
export class MessageRetention {
  constructor(private readonly db: Database) {}

  /**
   * Clears or deletes up to `limit` of each kind older than twelve months at `at`, the oldest
   * first. A shop whose transaction fails is told to `failed`, and the rest go on; without
   * `failed`, its error is thrown.
   */
  async purge(
    at: Date = new Date(),
    limit = RETENTION_BATCH,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<PurgedCounts> {
    const before = sql`${at.toISOString()}::timestamptz - ${MESSAGE_CONTENT_KEPT}::interval`;
    const purged: PurgedCounts = {
      messages: 0,
      conversationMessages: 0,
      conversations: 0,
      contactMessages: 0,
    };
    const holding = sql`(variables <> '{}'::jsonb OR error IS NOT NULL) AND created_at <= ${before}`;
    purged.messages = await this.#each(
      sql`SELECT shop_id, id FROM messaging.messages WHERE ${holding}
           ORDER BY created_at LIMIT ${limit}`,
      (shopId, ids) => sql`
        UPDATE messaging.messages SET variables = '{}'::jsonb, error = NULL
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[]) AND ${holding}
        RETURNING id`,
      failed,
    );
    purged.conversationMessages = await this.#each(
      sql`SELECT shop_id, id FROM messaging.conversation_messages WHERE at <= ${before}
           ORDER BY at LIMIT ${limit}`,
      (shopId, ids) => sql`
        WITH gone AS (
          DELETE FROM messaging.conversation_messages
           WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[]) AND at <= ${before}
          RETURNING id, conversation_id),
        -- What is unread is at most what is left of what the customer wrote.
        counted AS (
          UPDATE messaging.conversations c
             SET unread = least(c.unread, (
                   SELECT count(*) FROM messaging.conversation_messages m
                    WHERE m.shop_id = c.shop_id AND m.conversation_id = c.id
                      AND m.direction = 'inbound' AND m.at > ${before}))
           WHERE c.shop_id = ${shopId} AND c.id IN (SELECT conversation_id FROM gone)
             AND c.unread > 0)
        SELECT id FROM gone`,
      failed,
    );
    const empty = sql`
      last_message_at <= ${before}
      AND NOT EXISTS (SELECT 1 FROM messaging.conversation_messages m
                       WHERE m.shop_id = c.shop_id AND m.conversation_id = c.id)`;
    purged.conversations = await this.#each(
      sql`SELECT shop_id, id FROM messaging.conversations c WHERE ${empty}
           ORDER BY last_message_at LIMIT ${limit}`,
      (shopId, ids) => sql`
        DELETE FROM messaging.conversations c
         WHERE c.shop_id = ${shopId} AND c.id = ANY(${sql.param(ids)}::uuid[]) AND ${empty}
        RETURNING c.id`,
      failed,
    );
    purged.contactMessages = await this.#each(
      sql`SELECT shop_id, id FROM messaging.contact_messages WHERE created_at <= ${before}
           ORDER BY created_at LIMIT ${limit}`,
      (shopId, ids) => sql`
        DELETE FROM messaging.contact_messages
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])
           AND created_at <= ${before}
        RETURNING id`,
      failed,
    );
    return purged;
  }

  /** The rows `find` finds across shops, each shop's `change`d in its own transaction. */
  async #each(
    find: SQL,
    change: (shopId: string, ids: string[]) => SQL,
    failed?: (shopId: string, error: unknown) => void,
  ): Promise<number> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(find),
    );
    const byShop = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byShop.get(row.shop_id);
      if (ids) ids.push(row.id);
      else byShop.set(row.shop_id, [row.id]);
    }
    let changed = 0;
    for (const [shopId, ids] of byShop) {
      try {
        const { rows: done } = await this.db.tenant(shopId, (tx) =>
          tx.execute(change(shopId, ids)),
        );
        changed += done.length;
      } catch (error) {
        // One shop's failure is not the others': its rows are found again by the next sweep.
        if (!failed) throw error;
        failed(shopId, error);
      }
    }
    return changed;
  }
}

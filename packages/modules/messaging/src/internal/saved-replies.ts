import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { REPLY_MAX_LENGTH } from './conversations.service.js';

// The inbox's saved replies (MSG-06, ADR-758): what a shop's staff write to customers again and
// again, the price of delivery, the bank to transfer to, how to measure for a suit, kept with a
// title to answer with in a tap, in English, Urdu or both. Staff change them before sending, as
// any reply.

/** How many replies a shop keeps, and how long a title and a reply may be. */
export const SAVED_REPLY_LIMITS = { replies: 100, title: 60, body: REPLY_MAX_LENGTH } as const;

/** A saved reply, as the inbox offers it. */
export interface SavedReplyRecord {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a saved reply is made of, or changed to. */
export interface SavedReplyInput {
  title: string;
  body: string;
}

type Row = {
  id: string;
  title: string;
  body: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function recordOf(row: Row): SavedReplyRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** The input checked: its title and words trimmed, neither blank nor too long. */
function checked(input: SavedReplyInput): MutationResult<SavedReplyInput> {
  const check = new InputChecker();
  const title = check.text(['title'], input.title, {
    required: true,
    max: SAVED_REPLY_LIMITS.title,
  });
  const body = check.text(['body'], input.body, { required: true, max: SAVED_REPLY_LIMITS.body });
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, value: { title: title!, body: body! } };
}

/** Whether another of the shop's replies has this title, whatever its case. */
async function titleTaken(
  tx: Tx,
  shopId: string,
  title: string,
  except: string | null,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM messaging.saved_replies
     WHERE shop_id = ${shopId} AND lower(title) = lower(${title})
       ${except ? sql`AND id <> ${except}` : sql``}`);
  return rows.length > 0;
}

const TAKEN = (title: string) =>
  failOne<never>(['title'], 'TAKEN', `A saved reply is called ${title} already`);

/** A shop's saved replies (MSG-06, ADR-758): kept, changed and deleted one at a time. */
@Injectable()
export class SavedRepliesService {
  constructor(private readonly db: Database) {}

  /** The shop's saved replies, by their titles. */
  async list(tenant: TenantContext): Promise<SavedReplyRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        SELECT id, title, body, created_at, updated_at FROM messaging.saved_replies
         WHERE shop_id = ${tenant.shopId}
         ORDER BY lower(title), id`);
      return rows.map(recordOf);
    });
  }

  /** Keeps a new saved reply, of a title none of the shop's others has. */
  async create(
    tenant: TenantContext,
    input: SavedReplyInput,
  ): Promise<MutationResult<SavedReplyRecord>> {
    const given = checked(input);
    if (!given.ok) return given;
    const { title, body } = given.value;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.saved_replies
         WHERE shop_id = ${tenant.shopId}`);
      if ((counted[0]?.count ?? 0) >= SAVED_REPLY_LIMITS.replies) {
        return failOne<never>(
          ['title'],
          'TOO_MANY',
          `A shop keeps ${SAVED_REPLY_LIMITS.replies} saved replies at most`,
        );
      }
      if (await titleTaken(tx, tenant.shopId, title, null)) return TAKEN(title);
      const { rows } = await tx.execute<Row>(sql`
        INSERT INTO messaging.saved_replies (shop_id, title, body)
        VALUES (${tenant.shopId}, ${title}, ${body})
        RETURNING id, title, body, created_at, updated_at`);
      return { ok: true as const, value: recordOf(rows[0]!) };
    });
  }

  /** Changes a saved reply's title and words. */
  async update(
    tenant: TenantContext,
    id: string,
    input: SavedReplyInput,
  ): Promise<MutationResult<SavedReplyRecord>> {
    const given = checked(input);
    if (!given.ok) return given;
    const { title, body } = given.value;
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (await titleTaken(tx, tenant.shopId, title, id)) return TAKEN(title);
      const { rows } = await tx.execute<Row>(sql`
        UPDATE messaging.saved_replies SET title = ${title}, body = ${body}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id, title, body, created_at, updated_at`);
      return rows[0]
        ? { ok: true as const, value: recordOf(rows[0]) }
        : failOne<never>(['id'], 'NOT_FOUND', 'No such saved reply');
    });
  }

  /** Deletes a saved reply: whether there was one. */
  async delete(tenant: TenantContext, id: string): Promise<boolean> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute(sql`
        DELETE FROM messaging.saved_replies WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`);
      return rows.length > 0;
    });
  }
}

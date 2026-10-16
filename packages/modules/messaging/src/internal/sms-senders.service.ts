import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Shops' own SMS sender names (MKT-02, ADR-469): a shop asks for its SMS to come from a name of
// its own, such as ZARI, rather than Hatti's shared sender. Operators register such names, so
// Hatti's people approve or refuse each with why, and may take one back. Once approved, its
// customers' SMS go from it; Hatti's word to the shop itself goes from Hatti's.

export type SmsSenderStatus =
  'waiting' | 'approved' | 'refused' | 'withdrawn' | 'replaced' | 'revoked';

export const SMS_SENDER_LIMITS = {
  /** What operators register: 3 to 11 letters, digits and single spaces. */
  min: 3,
  max: 11,
  answer: 1000,
  by: 100,
  /** The requests the shop sees, the newest first. */
  listed: 10,
} as const;

export interface SmsSenderRecord {
  id: string;
  shopId: string;
  name: string;
  status: SmsSenderStatus;
  askedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  answer: string | null;
}

/** A request as Hatti's people review it, with the shop it is for. */
export interface SmsSenderReview extends SmsSenderRecord {
  shopName: string;
  shopHandle: string;
}

/** The shop's sender as it sees it: the name its SMS go from, and its requests. */
export interface ShopSmsSenderRecord {
  /** The name approved and in use; null while its SMS go from Hatti's shared sender. */
  name: string | null;
  requests: SmsSenderRecord[];
}

/** Why a decision was not made. */
export type SmsSenderDecisionProblem = 'not_found' | 'decided' | 'taken';

type Row = {
  id: string;
  shop_id: string;
  name: string;
  status: SmsSenderStatus;
  asked_by: string;
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  answer: string | null;
  shop_name?: string;
  shop_handle?: string;
};

/** A sender name as typed, its spaces made single; null unless operators would take it. */
export function smsSenderName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= SMS_SENDER_LIMITS.min &&
    name.length <= SMS_SENDER_LIMITS.max &&
    /^[A-Za-z0-9 ]+$/.test(name) &&
    /[A-Za-z]/.test(name)
    ? name
    : null;
}

@Injectable()
export class SmsSendersService {
  constructor(private readonly db: Database) {}

  /** The name the shop's SMS go from, and its latest requests, the newest first. */
  async status(tenant: TenantContext): Promise<ShopSmsSenderRecord> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        SELECT * FROM messaging.sms_senders WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at DESC, id DESC LIMIT ${SMS_SENDER_LIMITS.listed}`);
      return { name: await approvedIn(tx, tenant.shopId), requests: rows.map(toRecord) };
    });
  }

  /**
   * Asks Hatti for the shop's SMS to go from `name`: in place of any it has, once approved. One
   * request waits at a time.
   */
  async request(
    tenant: TenantContext,
    input: { name: string },
    askedBy: string,
    now: Date = new Date(),
  ): Promise<MutationResult<SmsSenderRecord>> {
    const check = new InputChecker();
    const name = smsSenderName(input.name);
    if (!name) {
      check.addMessage(
        ['name'],
        input.name.trim() ? 'INVALID' : 'BLANK',
        `Give ${SMS_SENDER_LIMITS.min} to ${SMS_SENDER_LIMITS.max} letters and digits, ` +
          'a letter among them, like ZARI',
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: open } = await tx.execute<{ name: string; status: SmsSenderStatus }>(sql`
        SELECT name, status FROM messaging.sms_senders
         WHERE shop_id = ${tenant.shopId} AND status IN ('waiting', 'approved')`);
      if (open.some((row) => row.status === 'waiting')) {
        return failOne<SmsSenderRecord>(['name'], 'TAKEN', 'A request waits for Hatti already');
      }
      if (open.some((row) => row.name.toLowerCase() === name!.toLowerCase())) {
        return failOne<SmsSenderRecord>(['name'], 'TAKEN', 'Your SMS go from this name already');
      }
      const { rows } = await tx.execute<Row>(sql`
        INSERT INTO messaging.sms_senders (shop_id, name, asked_by, created_at)
        VALUES (${tenant.shopId}, ${name!}, ${askedBy}, ${now.toISOString()})
        RETURNING *`);
      return { ok: true, value: toRecord(rows[0]!) };
    });
  }

  /** Withdraws the shop's request waiting, if one does. */
  async withdraw(tenant: TenantContext, now: Date = new Date()): Promise<SmsSenderRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        UPDATE messaging.sms_senders
           SET status = 'withdrawn', decided_at = ${now.toISOString()}
         WHERE shop_id = ${tenant.shopId} AND status = 'waiting'
        RETURNING *`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /** The name the shop's SMS to its customers go from; null for Hatti's shared sender. */
  async senderOf(shopId: string): Promise<string | null> {
    return this.db.tenant(shopId, (tx) => approvedIn(tx, shopId));
  }

  /** Requests for Hatti's people: those waiting, the oldest first, or all, the latest first. */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<SmsSenderReview[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<Row>(sql`
        SELECT r.*, s.name AS shop_name, s.handle AS shop_handle
          FROM messaging.sms_senders r JOIN control.shops s ON s.id = r.shop_id
         ${options.all ? sql`` : sql`WHERE r.status = 'waiting'`}
         ORDER BY ${options.all ? sql`r.created_at DESC` : sql`r.created_at`}, r.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toReview);
  }

  /** The shop of a request, for checking it before deciding: null for none. */
  async shopOf(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(
        sql`SELECT shop_id FROM messaging.sms_senders WHERE id = ${id}`,
      ),
    );
    return rows[0]?.shop_id ?? null;
  }

  /**
   * Approves a request waiting, as its operators registered it: the shop's SMS go from its name,
   * in place of any before. A name another shop sends from is refused.
   */
  async approve(
    id: string,
    input: { by: string; note?: string },
    now: Date = new Date(),
  ): Promise<SmsSenderReview | SmsSenderDecisionProblem> {
    return this.#decide(id, 'approved', input.by, input.note ?? '', now);
  }

  /** Refuses a request waiting, with why, which the shop reads. */
  async refuse(
    id: string,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<SmsSenderReview | SmsSenderDecisionProblem> {
    if (!input.answer.trim()) throw new RangeError('Say why it is refused');
    return this.#decide(id, 'refused', input.by, input.answer, now);
  }

  async #decide(
    id: string,
    status: 'approved' | 'refused',
    by: string,
    answer: string,
    now: Date,
  ): Promise<SmsSenderReview | SmsSenderDecisionProblem> {
    if (!isUuid(id)) return 'not_found';
    const decidedBy = by.trim().slice(0, SMS_SENDER_LIMITS.by);
    if (!decidedBy) throw new RangeError('Say who decided');
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<Row>(
        sql`SELECT * FROM messaging.sms_senders WHERE id = ${id} FOR UPDATE`,
      );
      const row = rows[0];
      if (!row) return 'not_found' as const;
      if (row.status !== 'waiting') return 'decided' as const;
      if (status === 'approved') {
        const { rows: taken } = await tx.execute(sql`
          SELECT 1 FROM messaging.sms_senders
           WHERE lower(name) = ${row.name.toLowerCase()} AND status = 'approved'
             AND shop_id <> ${row.shop_id}`);
        if (taken.length > 0) return 'taken' as const;
        await tx.execute(sql`
          UPDATE messaging.sms_senders
             SET status = 'replaced', decided_at = ${now.toISOString()}, decided_by = ${decidedBy}
           WHERE shop_id = ${row.shop_id} AND status = 'approved'`);
      }
      await tx.execute(sql`
        UPDATE messaging.sms_senders
           SET status = ${status}, decided_at = ${now.toISOString()}, decided_by = ${decidedBy},
               answer = ${answer.trim().slice(0, SMS_SENDER_LIMITS.answer) || null}
         WHERE shop_id = ${row.shop_id} AND id = ${id}`);
      return reviewOf(tx, row.shop_id, id);
    });
  }

  /**
   * Takes back the name the shop `named`, by its handle or ID, sends from, with why: its SMS go
   * from Hatti's shared sender again.
   */
  async revoke(
    named: string,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<SmsSenderReview | 'not_found' | 'not_approved'> {
    const by = input.by.trim().slice(0, SMS_SENDER_LIMITS.by);
    const answer = input.answer.trim().slice(0, SMS_SENDER_LIMITS.answer);
    if (!by || !answer) throw new RangeError('Say who took it back, and why');
    const handle = named.trim().toLowerCase();
    return this.db.system(async (tx) => {
      const { rows: shops } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM control.shops
         WHERE ${isUuid(handle) ? sql`id = ${handle}` : sql`handle = ${handle}`}`);
      const shop = shops[0];
      if (!shop) return 'not_found' as const;
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE messaging.sms_senders
           SET status = 'revoked', decided_at = ${now.toISOString()}, decided_by = ${by},
               answer = ${answer}
         WHERE shop_id = ${shop.id} AND status = 'approved'
        RETURNING id`);
      if (!rows[0]) return 'not_approved' as const;
      return reviewOf(tx, shop.id, rows[0].id);
    });
  }
}

async function approvedIn(tx: Tx, shopId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT name FROM messaging.sms_senders WHERE shop_id = ${shopId} AND status = 'approved'`);
  return rows[0]?.name ?? null;
}

async function reviewOf(tx: Tx, shopId: string, id: string): Promise<SmsSenderReview> {
  const { rows } = await tx.execute<Row>(sql`
    SELECT r.*, s.name AS shop_name, s.handle AS shop_handle
      FROM messaging.sms_senders r JOIN control.shops s ON s.id = r.shop_id
     WHERE r.shop_id = ${shopId} AND r.id = ${id}`);
  return toReview(rows[0]!);
}

function toRecord(row: Row): SmsSenderRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    status: row.status,
    askedBy: row.asked_by,
    createdAt: toDate(row.created_at),
    decidedAt: toDateOrNull(row.decided_at),
    decidedBy: row.decided_by,
    answer: row.answer,
  };
}

function toReview(row: Row): SmsSenderReview {
  return { ...toRecord(row), shopName: row.shop_name ?? '', shopHandle: row.shop_handle ?? '' };
}

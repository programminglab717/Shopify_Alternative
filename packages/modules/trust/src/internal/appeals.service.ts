import { secretToken, sha256 } from '@hatti/crypto';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ReportReason } from './reports.service.js';

// Appeals of stores taken down (TNS-01, ADR-462): the owner can't sign in while their store is
// down, so the notice telling them carries a link of its own, whose page says why, takes their
// side of it and shows Hatti's answer. One open at a time, three a takedown at most; Hatti's
// people refuse one with why, or restore the store, which upholds it.

/** Where appeals' links are, on the core's own address: /appeal/<token>. */
export const APPEAL_LINK_PATH = 'appeal';

export const APPEAL_LIMITS = { words: 2000, answer: 1000, by: 100, perTakedown: 3 } as const;

/** A new appeal link's secret: 24 random bytes, 32 characters. */
export function appealToken(): string {
  return secretToken('', 24);
}

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export type AppealStatus = 'open' | 'refused' | 'upheld';

/** An appeal, as its link's page shows it to the owner. */
export interface AppealEntry {
  words: string;
  status: AppealStatus;
  answer: string | null;
  createdAt: Date;
  answeredAt: Date | null;
}

/** What an appeal link's page shows: the takedown, its appeals, and whether another may come. */
export interface AppealView {
  shopName: string;
  reason: ReportReason;
  /** Why it is down, as the owner was told. */
  note: string;
  takenAt: Date;
  restoredAt: Date | null;
  appeals: AppealEntry[];
  /** Down, with no appeal waiting and fewer than three made. */
  canAppeal: boolean;
}

/** Why an appeal was not taken. */
export type AppealProblem = 'blank' | 'too_long' | 'restored' | 'waiting' | 'too_many';

export type AppealResult =
  { ok: true; view: AppealView } | { ok: false; problem: AppealProblem; view: AppealView };

/** An appeal, as Hatti's people see it. */
export interface AppealRecord {
  id: string;
  shopId: string;
  shopName: string;
  shopHandle: string;
  takedownId: string;
  reason: ReportReason;
  /** Why the store is down, as its owner was told. */
  takedownNote: string;
  words: string;
  status: AppealStatus;
  createdAt: Date;
  answeredAt: Date | null;
  answeredBy: string | null;
  answer: string | null;
}

type AppealRow = {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_handle: string;
  takedown_id: string;
  reason: ReportReason;
  takedown_note: string;
  words: string;
  status: AppealStatus;
  created_at: string | Date;
  answered_at: string | Date | null;
  answered_by: string | null;
  answer: string | null;
};

const SELECT = sql`
  SELECT a.id, a.shop_id, s.name AS shop_name, s.handle AS shop_handle, a.takedown_id,
         t.reason, t.note AS takedown_note, a.words, a.status, a.created_at, a.answered_at,
         a.answered_by, a.answer
    FROM trust.appeals a
    JOIN trust.takedowns t ON t.shop_id = a.shop_id AND t.id = a.takedown_id
    JOIN control.shops s ON s.id = a.shop_id`;

type TakedownRow = {
  shop_id: string;
  id: string;
  shop_name: string;
  reason: ReportReason;
  note: string;
  created_at: string | Date;
  restored_at: string | Date | null;
};

@Injectable()
export class AppealsService {
  constructor(private readonly db: Database) {}

  /** What the appeal link `token` shows; null for a link that names no takedown. */
  async view(token: string): Promise<AppealView | null> {
    const link = await this.#resolve(token);
    if (!link) return null;
    return this.db.tenant(link.shopId, async (tx) => {
      const takedown = await takedownOf(tx, link);
      return takedown && viewOf(tx, takedown);
    });
  }

  /**
   * Takes the owner's side of their store's takedown, through its link: while it is down, one
   * waiting at a time and three in all. Null for a link that names no takedown.
   */
  async appeal(token: string, words: string, now: Date = new Date()): Promise<AppealResult | null> {
    const link = await this.#resolve(token);
    if (!link) return null;
    return this.db.tenant(link.shopId, async (tx) => {
      const takedown = await takedownOf(tx, link, true);
      if (!takedown) return null;
      const view = await viewOf(tx, takedown);
      const typed = words.trim();
      let problem: AppealProblem | null = null;
      if (takedown.restored_at) problem = 'restored';
      else if (view.appeals.some((appeal) => appeal.status === 'open')) problem = 'waiting';
      else if (view.appeals.length >= APPEAL_LIMITS.perTakedown) problem = 'too_many';
      else if (!typed) problem = 'blank';
      else if (typed.length > APPEAL_LIMITS.words) problem = 'too_long';
      if (problem) return { ok: false, problem, view };
      await tx.execute(sql`
        INSERT INTO trust.appeals (shop_id, takedown_id, words, created_at)
        VALUES (${takedown.shop_id}, ${takedown.id}, ${typed}, ${now.toISOString()})`);
      return { ok: true, view: await viewOf(tx, takedown) };
    });
  }

  /**
   * The takedown a link's secret belongs to, found without knowing the shop, through the
   * database's function: requests have no system login.
   */
  async #resolve(token: string): Promise<TakedownLink | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; takedown_id: string }>(
      sql`SELECT * FROM trust.resolve_appeal_link(${sha256(token)})`,
    );
    const row = rows[0];
    return row ? { shopId: row.shop_id, takedownId: row.takedown_id } : null;
  }

  /** Appeals for Hatti's people: those waiting, the oldest first, or all, the latest first. */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<AppealRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<AppealRow>(sql`
        ${SELECT}
         ${options.all ? sql`` : sql`WHERE a.status = 'open'`}
         ORDER BY ${options.all ? sql`a.created_at DESC` : sql`a.created_at`}, a.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toRecord);
  }

  /** Refuses an appeal waiting, with why, which its link's page shows the owner. Once. */
  async refuse(
    id: string,
    input: { by: string; answer: string },
    now: Date = new Date(),
  ): Promise<AppealRecord | 'not_found' | 'answered'> {
    if (!isUuid(id)) return 'not_found';
    const by = input.by.trim().slice(0, APPEAL_LIMITS.by);
    const answer = input.answer.trim().slice(0, APPEAL_LIMITS.answer);
    if (!by || !answer) throw new RangeError('Say who refused it, and why');
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.appeals
           SET status = 'refused', answered_at = ${now.toISOString()}, answered_by = ${by},
               answer = ${answer}
         WHERE id = ${id} AND status = 'open'
        RETURNING id`);
      if (rows.length === 0) {
        const { rows: found } = await tx.execute<{ id: string }>(
          sql`SELECT id FROM trust.appeals WHERE id = ${id}`,
        );
        return found.length === 0 ? 'not_found' : 'answered';
      }
      const { rows: refused } = await tx.execute<AppealRow>(sql`${SELECT} WHERE a.id = ${id}`);
      return toRecord(refused[0]!);
    });
  }
}

interface TakedownLink {
  shopId: string;
  takedownId: string;
}

async function takedownOf(tx: Tx, link: TakedownLink, lock = false): Promise<TakedownRow | null> {
  const { rows } = await tx.execute<TakedownRow>(sql`
    SELECT t.shop_id, t.id, s.name AS shop_name, t.reason, t.note, t.created_at, t.restored_at
      FROM trust.takedowns t
      JOIN control.shops s ON s.id = t.shop_id
     WHERE t.shop_id = ${link.shopId} AND t.id = ${link.takedownId}
     ${lock ? sql`FOR UPDATE OF t` : sql``}`);
  return rows[0] ?? null;
}

async function viewOf(tx: Tx, takedown: TakedownRow): Promise<AppealView> {
  const { rows } = await tx.execute<{
    words: string;
    status: AppealStatus;
    answer: string | null;
    created_at: string | Date;
    answered_at: string | Date | null;
  }>(sql`
    SELECT words, status, answer, created_at, answered_at FROM trust.appeals
     WHERE shop_id = ${takedown.shop_id} AND takedown_id = ${takedown.id}
     ORDER BY created_at, id`);
  const appeals = rows.map((row) => ({
    words: row.words,
    status: row.status,
    answer: row.answer,
    createdAt: toDate(row.created_at),
    answeredAt: toDateOrNull(row.answered_at),
  }));
  const restoredAt = toDateOrNull(takedown.restored_at);
  return {
    shopName: takedown.shop_name,
    reason: takedown.reason,
    note: takedown.note,
    takenAt: toDate(takedown.created_at),
    restoredAt,
    appeals,
    canAppeal:
      restoredAt === null &&
      !appeals.some((appeal) => appeal.status === 'open') &&
      appeals.length < APPEAL_LIMITS.perTakedown,
  };
}

function toRecord(row: AppealRow): AppealRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopHandle: row.shop_handle,
    takedownId: row.takedown_id,
    reason: row.reason,
    takedownNote: row.takedown_note,
    words: row.words,
    status: row.status,
    createdAt: toDate(row.created_at),
    answeredAt: toDateOrNull(row.answered_at),
    answeredBy: row.answered_by,
    answer: row.answer,
  };
}

import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { isUuid } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { REPORT_REASONS, type ReportReason } from './reports.service.js';

// Stores taken down (TNS-01, ADR-461): when what shoppers report of a store is upheld, Hatti's
// people suspend the shop, which closes its storefront to Hatti's page saying so, its checkout and
// its staff's sign-ins, as for any shop not active; restoring it opens them again. Each is kept
// with who took it down and why, and who restored it.

/** The events of a store taken down and restored, which republish its storefront. */
export const TrustEvents = {
  StoreSuspended: 'trust.store_suspended',
  StoreRestored: 'trust.store_restored',
} as const;

export interface TakedownPayload {
  takedownId: string;
}

export const TAKEDOWN_LIMITS = { note: 1000, by: 100 } as const;

/** A store's takedown, as Hatti's people see it. */
export interface TakedownRecord {
  id: string;
  shopId: string;
  shopName: string;
  shopHandle: string;
  reason: ReportReason;
  /** What the owner was told of why. */
  note: string;
  takenBy: string;
  createdAt: Date;
  restoredAt: Date | null;
  restoredBy: string | null;
  restoreNote: string | null;
}

/** A shop as a takedown names it: by its handle or its ID. */
export interface TakedownShop {
  id: string;
  name: string;
  handle: string;
  status: 'active' | 'suspended' | 'closed';
}

/** What became of a takedown asked for, or of restoring a store. */
export type TakedownResult = TakedownRecord | 'not_found' | 'not_active' | 'not_suspended';

type TakedownRow = {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_handle: string;
  reason: ReportReason;
  note: string;
  taken_by: string;
  created_at: string | Date;
  restored_at: string | Date | null;
  restored_by: string | null;
  restore_note: string | null;
};

const SELECT = sql`
  SELECT t.id, t.shop_id, s.name AS shop_name, s.handle AS shop_handle, t.reason, t.note,
         t.taken_by, t.created_at, t.restored_at, t.restored_by, t.restore_note
    FROM trust.takedowns t
    JOIN control.shops s ON s.id = t.shop_id`;

@Injectable()
export class TakedownsService {
  constructor(private readonly db: Database) {}

  /** The shop `named` names, by its handle or its ID, whatever its status; null if none. */
  async shop(named: string): Promise<TakedownShop | null> {
    return this.db.system((tx) => shopNamed(tx, named));
  }

  /**
   * Takes the store down: the shop suspended, if it is active, and the takedown kept with why, in
   * Hatti's people's words, and by whom. Its storefront is published again, saying so.
   */
  async suspend(
    named: string,
    input: { reason: string; note: string; by: string },
    now: Date = new Date(),
  ): Promise<TakedownResult> {
    if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) {
      throw new RangeError(`No such reason: ${input.reason}`);
    }
    const note = required(input.note, TAKEDOWN_LIMITS.note, 'note');
    const by = required(input.by, TAKEDOWN_LIMITS.by, 'by');
    return this.db.system(async (tx) => {
      const shop = await shopNamed(tx, named);
      if (!shop) return 'not_found';
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE control.shops SET status = 'suspended', updated_at = ${now.toISOString()}
         WHERE id = ${shop.id} AND status = 'active'
        RETURNING id`);
      if (rows.length === 0) return 'not_active';
      const { rows: taken } = await tx.execute<{ id: string }>(sql`
        INSERT INTO trust.takedowns (shop_id, reason, note, taken_by, created_at)
        VALUES (${shop.id}, ${input.reason}, ${note}, ${by}, ${now.toISOString()})
        RETURNING id`);
      const id = taken[0]!.id;
      await appendEvent<TakedownPayload>(tx, shop.id, {
        type: TrustEvents.StoreSuspended,
        aggregateType: 'shop',
        aggregateId: shop.id,
        payload: { takedownId: id },
      });
      return recordOf(tx, id);
    });
  }

  /** Restores a store taken down: the shop active again, and why kept on its takedown. */
  async restore(
    named: string,
    input: { note: string; by: string },
    now: Date = new Date(),
  ): Promise<TakedownResult> {
    const note = required(input.note, TAKEDOWN_LIMITS.note, 'note');
    const by = required(input.by, TAKEDOWN_LIMITS.by, 'by');
    return this.db.system(async (tx) => {
      const shop = await shopNamed(tx, named);
      if (!shop) return 'not_found';
      if (shop.status !== 'suspended') return 'not_suspended';
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE trust.takedowns
           SET restored_at = ${now.toISOString()}, restored_by = ${by}, restore_note = ${note}
         WHERE shop_id = ${shop.id} AND restored_at IS NULL
        RETURNING id`);
      if (rows.length === 0) return 'not_suspended';
      await tx.execute(sql`
        UPDATE control.shops SET status = 'active', updated_at = ${now.toISOString()}
         WHERE id = ${shop.id}`);
      await appendEvent<TakedownPayload>(tx, shop.id, {
        type: TrustEvents.StoreRestored,
        aggregateType: 'shop',
        aggregateId: shop.id,
        payload: { takedownId: rows[0]!.id },
      });
      return recordOf(tx, rows[0]!.id);
    });
  }

  /** Takedowns, the latest first: those of stores still down, or all. */
  async list(options: { all?: boolean; limit?: number } = {}): Promise<TakedownRecord[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<TakedownRow>(sql`
        ${SELECT}
         ${options.all ? sql`` : sql`WHERE t.restored_at IS NULL`}
         ORDER BY t.created_at DESC, t.id
         LIMIT ${options.limit ?? 100}`),
    );
    return rows.map(toRecord);
  }
}

async function shopNamed(tx: Tx, named: string): Promise<TakedownShop | null> {
  const wanted = named.trim().toLowerCase();
  const { rows } = await tx.execute<TakedownShop & Record<string, unknown>>(
    isUuid(wanted)
      ? sql`SELECT id, name, handle, status FROM control.shops WHERE id = ${wanted}`
      : sql`SELECT id, name, handle, status FROM control.shops WHERE handle = ${wanted}`,
  );
  return rows[0] ?? null;
}

async function recordOf(tx: Tx, id: string): Promise<TakedownRecord> {
  const { rows } = await tx.execute<TakedownRow>(sql`${SELECT} WHERE t.id = ${id}`);
  return toRecord(rows[0]!);
}

function required(value: string, max: number, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new RangeError(`The ${name} takes 1 to ${max} characters`);
  }
  return trimmed;
}

function toRecord(row: TakedownRow): TakedownRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopHandle: row.shop_handle,
    reason: row.reason,
    note: row.note,
    takenBy: row.taken_by,
    createdAt: toDate(row.created_at),
    restoredAt: toDateOrNull(row.restored_at),
    restoredBy: row.restored_by,
    restoreNote: row.restore_note,
  };
}

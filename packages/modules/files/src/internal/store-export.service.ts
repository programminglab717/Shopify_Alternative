import {
  actorColumnsOf,
  failOne,
  isStaffRole,
  type MutationResult,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { ObjectStorage } from '@hatti/storage';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { FileEvents, type StoreExportPayload } from './events.js';
import { storeExports, type StoreExportRow, type StoreExportStatusValue } from './schema.js';

export const STORE_EXPORT_LIMITS = {
  /** Exports an owner may ask for in a day: each reads the whole store. */
  perDay: 3,
  /** How long a worker holds an export it is making before another may try: 30 minutes. */
  leaseMs: 30 * 60_000,
  /** Tries before an export fails. */
  attempts: 3,
  /** How long storage keeps a ready export: a week. */
  keepDays: 7,
  /** Exports listed: the latest. */
  listed: 10,
} as const;

/** How long an export's link downloads it: an hour. */
export const STORE_EXPORT_URL_SECONDS = 3600;

const ZIP = 'application/zip';

/** A whole store exported, as its owner sees it (ADM-10, ADR-415). */
export interface StoreExportRecord {
  id: string;
  requestedBy: string;
  status: StoreExportStatusValue;
  /** Bytes of the ZIP, once ready. */
  size: number | null;
  /** Why it failed, in words for the owner. */
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** When storage lets the ZIP go. */
  expiresAt: Date | null;
  /** Where storage keeps it while ready. */
  key: string | null;
}

/** An export a worker took to make: as whom, in which currency. */
export interface StoreExportTask {
  shopId: string;
  id: string;
  requestedBy: string;
  /** The role of whoever asked, now; null once they no longer work in the shop. */
  role: StaffRole | null;
  currency: string;
  createdAt: Date;
}

/**
 * The whole store exported (ADM-10, ADR-415): an owner asks, and a worker makes a ZIP of
 * everything the shop keeps, as that owner, which storage keeps for a week, downloaded through
 * links that last an hour. What goes in it is the core's to gather, from each module's own export;
 * this service keeps the exports asked for, takes them for workers, and stores what they make.
 */
@Injectable()
export class StoreExportService {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Asks for an export, made as the member of staff asking: one at a time, and at most
   * {@link STORE_EXPORT_LIMITS.perDay} a day. Recorded in the audit log.
   */
  async request(
    tenant: TenantContext,
    at = new Date(),
  ): Promise<MutationResult<StoreExportRecord>> {
    const actor = tenant.actor;
    if (actor.kind !== 'staff') {
      return failOne([], 'INVALID', "Only the shop's owner exports the whole store");
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      // One request at a time per shop, so that two cannot both pass the checks below.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`store_export:${tenant.shopId}`}, 0))`,
      );
      const latest = await tx
        .select({ status: storeExports.status })
        .from(storeExports)
        .where(
          and(
            eq(storeExports.shopId, tenant.shopId),
            gte(storeExports.createdAt, new Date(at.getTime() - 86_400_000)),
          ),
        );
      if (latest.some((row) => row.status === 'pending')) {
        return failOne([], 'IN_USE', 'An export is being made: it is ready in a few minutes');
      }
      if (latest.length >= STORE_EXPORT_LIMITS.perDay) {
        return failOne(
          [],
          'TOO_MANY',
          `The store can be exported ${STORE_EXPORT_LIMITS.perDay} times a day: try again tomorrow`,
        );
      }
      const [row] = await tx
        .insert(storeExports)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          requestedBy: actor.userId,
          createdAt: at,
        })
        .returning();
      await appendEvent<StoreExportPayload>(tx, tenant.shopId, {
        type: FileEvents.StoreExportRequested,
        aggregateType: 'store_export',
        aggregateId: row!.id,
        payload: {},
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'store.export_requested',
        subjectType: 'storeExport',
        subjectId: row!.id,
        ...actorColumnsOf(actor),
      });
      return { ok: true, value: toRecord(row!) };
    });
  }

  /** The shop's latest exports, newest first. */
  async list(tenant: TenantContext): Promise<StoreExportRecord[]> {
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(storeExports)
        .where(eq(storeExports.shopId, tenant.shopId))
        .orderBy(desc(storeExports.createdAt), desc(storeExports.id))
        .limit(STORE_EXPORT_LIMITS.listed),
    );
    return rows.map(toRecord);
  }

  /** A link that downloads a ready export for an hour; none for one not ready. */
  urlOf(record: StoreExportRecord): string | null {
    if (record.status !== 'ready' || !record.key) return null;
    const day = record.createdAt.toISOString().slice(0, 10);
    return this.storage.signDownload(record.key, STORE_EXPORT_URL_SECONDS, {
      filename: `store-export-${day}.zip`,
    });
  }

  /** Exports waiting at `at` across shops, the longest waiting first: found with the system role. */
  async waiting(at: Date, limit = 10): Promise<{ shopId: string; id: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM files.store_exports
         WHERE status = 'pending'
           AND (lease_until IS NULL OR lease_until <= ${at.toISOString()})
         ORDER BY created_at
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, id: row.id }));
  }

  /**
   * Takes export `id` to make, held for {@link STORE_EXPORT_LIMITS.leaseMs} so that no other
   * worker makes it too; null if it is not waiting. One tried as often as
   * {@link STORE_EXPORT_LIMITS.attempts} allows fails instead.
   */
  async take(shopId: string, id: string, at = new Date()): Promise<StoreExportTask | null> {
    const taken = await this.db.tenant(shopId, async (tx) => {
      const leaseUntil = new Date(at.getTime() + STORE_EXPORT_LIMITS.leaseMs);
      const [row] = await tx
        .update(storeExports)
        .set({ leaseUntil, attempts: sql`${storeExports.attempts} + 1` })
        .where(
          and(
            eq(storeExports.shopId, shopId),
            eq(storeExports.id, id),
            eq(storeExports.status, 'pending'),
            sql`(${storeExports.leaseUntil} IS NULL OR ${storeExports.leaseUntil} <= ${at.toISOString()})`,
          ),
        )
        .returning();
      if (!row) return null;
      const { rows: staff } = await tx.execute<{ role: string }>(sql`
        SELECT role FROM identity.staff_phones(${shopId}) WHERE user_id = ${row.requestedBy}`);
      const { rows: shops } = await tx.execute<{ currency: string }>(sql`
        SELECT currency FROM control.shops WHERE id = ${shopId}`);
      const role = staff[0]?.role;
      return {
        row,
        task: {
          shopId,
          id,
          requestedBy: row.requestedBy,
          role: role && isStaffRole(role) ? role : null,
          currency: shops[0]?.currency ?? 'PKR',
          createdAt: row.createdAt,
        },
      };
    });
    if (!taken) return null;
    if (taken.row.attempts > STORE_EXPORT_LIMITS.attempts) {
      await this.fail(shopId, id, 'It could not be made: ask for another', at);
      return null;
    }
    return taken.task;
  }

  /** Stores export `id`'s ZIP, ready for a week. */
  async finish(shopId: string, id: string, zip: Buffer, at = new Date()): Promise<void> {
    const key = `shops/${shopId}/exports/${id}.zip`;
    await this.storage.put(key, zip, ZIP);
    const expiresAt = new Date(at.getTime() + STORE_EXPORT_LIMITS.keepDays * 86_400_000);
    const done = await this.db.tenant(shopId, async (tx) => {
      const [row] = await tx
        .update(storeExports)
        .set({
          status: 'ready',
          key,
          size: zip.length,
          finishedAt: at,
          expiresAt,
          leaseUntil: null,
        })
        .where(
          and(
            eq(storeExports.shopId, shopId),
            eq(storeExports.id, id),
            eq(storeExports.status, 'pending'),
          ),
        )
        .returning({ id: storeExports.id });
      if (!row) return false;
      await appendEvent<StoreExportPayload>(tx, shopId, {
        type: FileEvents.StoreExportReady,
        aggregateType: 'store_export',
        aggregateId: id,
        payload: { size: zip.length },
      });
      return true;
    });
    // Made twice, as when a lease ran out: the other's stands.
    if (!done) await this.storage.delete(key).catch(() => undefined);
  }

  /** Export `id` failed, for `error`, in words for the owner. */
  async fail(shopId: string, id: string, error: string, at = new Date()): Promise<void> {
    await this.db.tenant(shopId, async (tx) => {
      const [row] = await tx
        .update(storeExports)
        .set({ status: 'failed', error, finishedAt: at, leaseUntil: null })
        .where(
          and(
            eq(storeExports.shopId, shopId),
            eq(storeExports.id, id),
            eq(storeExports.status, 'pending'),
          ),
        )
        .returning({ id: storeExports.id });
      if (!row) return;
      await appendEvent<StoreExportPayload>(tx, shopId, {
        type: FileEvents.StoreExportFailed,
        aggregateType: 'store_export',
        aggregateId: id,
        payload: { error },
      });
    });
  }

  /**
   * Lets go of the ZIPs of exports a week old at `at`, across shops: storage deletes each, and
   * the export says it expired. How many it let go.
   */
  async expire(at = new Date(), limit = 50): Promise<number> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string; key: string }>(sql`
        SELECT shop_id, id, key FROM files.store_exports
         WHERE status = 'ready' AND expires_at <= ${at.toISOString()}
         ORDER BY expires_at
         LIMIT ${limit}`),
    );
    for (const row of rows) {
      await this.storage.delete(row.key);
      await this.db.tenant(row.shop_id, (tx) =>
        tx
          .update(storeExports)
          .set({ status: 'expired', key: null })
          .where(and(eq(storeExports.shopId, row.shop_id), eq(storeExports.id, row.id))),
      );
    }
    return rows.length;
  }
}

function toRecord(row: StoreExportRow): StoreExportRecord {
  return {
    id: row.id,
    requestedBy: row.requestedBy,
    status: row.status,
    size: row.size,
    error: row.error,
    createdAt: toDate(row.createdAt),
    finishedAt: row.finishedAt && toDate(row.finishedAt),
    expiresAt: row.expiresAt && toDate(row.expiresAt),
    key: row.key,
  };
}

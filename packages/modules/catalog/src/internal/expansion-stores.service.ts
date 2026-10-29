import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Expansion stores (CH-11, ADR-859): an owner's other shop, kept with the shop its products are
// copied from, and the rate a price here is multiplied by there. The core checks the same owner
// holds both and runs the copy, through the product export and import, a shop at a time.

export const EXPANSION_STORE_LIMITS = { perShop: 5 } as const;

/**
 * Copying as products change (ADR-913): once the shop's products have been left alone
 * `quietMs`, so that a bulk edit is copied whole, and `everyMs` after the last copy, or the last
 * that failed, at most; `perSweep` links a sweep at most.
 */
export const EXPANSION_AUTO_COPY = {
  quietMs: 10 * 60 * 1000,
  everyMs: 60 * 60 * 1000,
  perSweep: 20,
} as const;

/** What a copy did, as the import says it. */
export interface ExpansionCopyResult {
  created: number;
  updated: number;
  /** Rows the expansion store could not take, as the import named them. */
  problems: number;
}

export interface ExpansionStoreRecord {
  targetShopId: string;
  /** As a decimal string: "0.0036". */
  priceRate: string;
  syncedAt: Date | null;
  lastResult: ExpansionCopyResult | null;
  /** Whether products are copied as they change (ADR-913). */
  autoCopy: boolean;
  /** Why the last copy as products changed failed, and when; null once one succeeds. */
  copyError: string | null;
  failedAt: Date | null;
  createdAt: Date;
}

type Row = {
  target_shop_id: string;
  price_rate: string;
  synced_at: Date | string | null;
  last_result: ExpansionCopyResult | null;
  auto_copy: boolean;
  copy_error: string | null;
  failed_at: Date | string | null;
  created_at: Date | string;
};

const COLUMNS = sql`target_shop_id, price_rate::text, synced_at, last_result, auto_copy, copy_error,
  failed_at, created_at`;

const toRecord = (row: Row): ExpansionStoreRecord => ({
  targetShopId: row.target_shop_id,
  priceRate: row.price_rate.replace(/\.?0+$/, ''),
  syncedAt: row.synced_at === null ? null : toDate(row.synced_at),
  lastResult: row.last_result,
  autoCopy: row.auto_copy,
  copyError: row.copy_error,
  failedAt: row.failed_at === null ? null : toDate(row.failed_at),
  createdAt: toDate(row.created_at),
});

/** A link due a copy as products changed: the shop products come from, and the one they go to. */
export interface ExpansionCopyDue {
  shopId: string;
  targetShopId: string;
}

const RATE = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/;

@Injectable()
export class ExpansionStoreService {
  constructor(private readonly db: Database) {}

  /** The shop's expansion stores, oldest first. */
  async list(tenant: TenantContext): Promise<ExpansionStoreRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        SELECT ${COLUMNS} FROM catalog.expansion_stores WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at, target_shop_id`),
    );
    return rows.map(toRecord);
  }

  async get(tenant: TenantContext, targetShopId: string): Promise<ExpansionStoreRecord | null> {
    return (await this.list(tenant)).find((each) => each.targetShopId === targetShopId) ?? null;
  }

  /**
   * Makes `targetShopId` an expansion store of the shop, or changes its rate: a decimal, "1" for
   * the same currency. The caller checks the same owner holds both.
   */
  async save(
    tenant: TenantContext,
    targetShopId: string,
    priceRate: string,
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const rate = priceRate.trim();
    if (!RATE.test(rate) || Number(rate) <= 0) {
      return failOne(
        ['priceRate'],
        'INVALID',
        'Give the rate as a number above nothing, such as 0.0036',
      );
    }
    if (targetShopId === tenant.shopId) {
      return failOne(['shopId'], 'INVALID', "A shop isn't its own expansion store");
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number; mine: boolean }>(sql`
        SELECT count(*)::int AS count, bool_or(target_shop_id = ${targetShopId}) AS mine
          FROM catalog.expansion_stores WHERE shop_id = ${tenant.shopId}`);
      if (!counted[0]?.mine && (counted[0]?.count ?? 0) >= EXPANSION_STORE_LIMITS.perShop) {
        return failOne<ExpansionStoreRecord>(
          ['shopId'],
          'TOO_MANY',
          `A shop has ${EXPANSION_STORE_LIMITS.perShop} expansion stores at most`,
        );
      }
      const { rows } = await tx.execute<Row>(sql`
        INSERT INTO catalog.expansion_stores (shop_id, target_shop_id, price_rate)
        VALUES (${tenant.shopId}, ${targetShopId}, ${rate}::numeric)
        ON CONFLICT (shop_id, target_shop_id) DO UPDATE SET price_rate = EXCLUDED.price_rate
        RETURNING ${COLUMNS}`);
      return { ok: true, value: toRecord(rows[0]!) };
    });
  }

  /** Ends the link: the expansion store keeps what was copied. */
  async remove(tenant: TenantContext, targetShopId: string): Promise<boolean> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        DELETE FROM catalog.expansion_stores
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING target_shop_id`),
    );
    return rows.length > 0;
  }

  /**
   * Keeps what the copy to `targetShopId` did, and when it began: `at`, so that a product changed
   * while it ran is copied the next time.
   */
  async copied(
    tenant: TenantContext,
    targetShopId: string,
    result: ExpansionCopyResult,
    at: Date = new Date(),
  ): Promise<ExpansionStoreRecord | null> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET synced_at = ${at.toISOString()}, last_result = ${JSON.stringify(result)}::jsonb,
               failed_at = NULL, copy_error = NULL
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Keeps why a copy as products changed failed, for the owner to see; tried again an hour on. */
  async failed(shopId: string, targetShopId: string, error: string, at: Date): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE catalog.expansion_stores
           SET failed_at = ${at.toISOString()}, copy_error = ${error.slice(0, 500)}
         WHERE shop_id = ${shopId} AND target_shop_id = ${targetShopId}`),
    );
  }

  /**
   * Has products copied to `targetShopId` as they change, or only when asked (ADR-913). Refused
   * where products copied there would come back here, the two copying each other's copies for
   * ever.
   */
  async setAutoCopy(
    tenant: TenantContext,
    targetShopId: string,
    enabled: boolean,
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    if (enabled && (await this.reaches(targetShopId, tenant.shopId))) {
      return failOne(
        ['shopId'],
        'INVALID',
        'Products copied there come back here as they change: turn that off there first',
      );
    }
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET auto_copy = ${enabled}, failed_at = NULL, copy_error = NULL
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`),
    );
    return rows[0]
      ? { ok: true, value: toRecord(rows[0]) }
      : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
  }

  /**
   * Whether products copied from `from` as they change reach `to`, through copies of copies: each
   * shop's links read as that shop's, as the API's login reads them.
   */
  private async reaches(from: string, to: string): Promise<boolean> {
    const seen = new Set([from]);
    const next = [from];
    while (next.length > 0) {
      const shop = next.pop()!;
      if (shop === to) return true;
      const { rows } = await this.db.tenant(shop, (tx) =>
        tx.execute<{ target_shop_id: string }>(sql`
          SELECT target_shop_id FROM catalog.expansion_stores
           WHERE shop_id = ${shop} AND auto_copy`),
      );
      for (const row of rows) {
        if (!seen.has(row.target_shop_id)) {
          seen.add(row.target_shop_id);
          next.push(row.target_shop_id);
        }
      }
    }
    return false;
  }

  /**
   * The links due a copy as products changed, as of `at`, across shops: copying as they change,
   * a product or variant of the shop changed since the last copy and none in the last
   * {@link EXPANSION_AUTO_COPY.quietMs}, and neither a copy nor a failure within the hour.
   */
  async dueForCopy(at: Date): Promise<ExpansionCopyDue[]> {
    const quiet = new Date(at.getTime() - EXPANSION_AUTO_COPY.quietMs).toISOString();
    const since = new Date(at.getTime() - EXPANSION_AUTO_COPY.everyMs).toISOString();
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; target_shop_id: string }>(sql`
        WITH changed AS (
          SELECT e.shop_id, e.target_shop_id, e.synced_at,
                 greatest(
                   (SELECT max(p.updated_at) FROM catalog.products p WHERE p.shop_id = e.shop_id),
                   (SELECT max(v.updated_at) FROM catalog.variants v WHERE v.shop_id = e.shop_id)
                 ) AS last_change
            FROM catalog.expansion_stores e
           WHERE e.auto_copy
             AND (e.synced_at IS NULL OR e.synced_at < ${since})
             AND (e.failed_at IS NULL OR e.failed_at < ${since})
        )
        SELECT shop_id, target_shop_id FROM changed
         WHERE last_change IS NOT NULL AND last_change < ${quiet}
           AND (synced_at IS NULL OR last_change > synced_at)
         ORDER BY synced_at NULLS FIRST, shop_id, target_shop_id
         LIMIT ${EXPANSION_AUTO_COPY.perSweep}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, targetShopId: row.target_shop_id }));
  }
}

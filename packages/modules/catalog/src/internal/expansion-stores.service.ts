import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Expansion stores (CH-11, ADR-859): an owner's other shop, kept with the shop its products are
// copied from, and the rate a price here is multiplied by there. The core checks the same owner
// holds both and runs the copy, through the product export and import, a shop at a time.

export const EXPANSION_STORE_LIMITS = { perShop: 5 } as const;

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
  createdAt: Date;
}

type Row = {
  target_shop_id: string;
  price_rate: string;
  synced_at: Date | string | null;
  last_result: ExpansionCopyResult | null;
  created_at: Date | string;
};

const toRecord = (row: Row): ExpansionStoreRecord => ({
  targetShopId: row.target_shop_id,
  priceRate: row.price_rate.replace(/\.?0+$/, ''),
  syncedAt: row.synced_at === null ? null : toDate(row.synced_at),
  lastResult: row.last_result,
  createdAt: toDate(row.created_at),
});

const RATE = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/;

@Injectable()
export class ExpansionStoreService {
  constructor(private readonly db: Database) {}

  /** The shop's expansion stores, oldest first. */
  async list(tenant: TenantContext): Promise<ExpansionStoreRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        SELECT target_shop_id, price_rate::text, synced_at, last_result, created_at
          FROM catalog.expansion_stores WHERE shop_id = ${tenant.shopId}
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
        RETURNING target_shop_id, price_rate::text, synced_at, last_result, created_at`);
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

  /** Keeps what the copy to `targetShopId` did, and when. */
  async copied(
    tenant: TenantContext,
    targetShopId: string,
    result: ExpansionCopyResult,
  ): Promise<ExpansionStoreRecord | null> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET synced_at = now(), last_result = ${JSON.stringify(result)}::jsonb
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING target_shop_id, price_rate::text, synced_at, last_result, created_at`),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

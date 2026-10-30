import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { PRESENTMENT_ROUNDINGS, type PresentmentRounding } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Expansion stores (CH-11, ADR-859): an owner's other shop, kept with the shop its products are
// copied from, and the rate a price here is multiplied by there. The core checks the same owner
// holds both and runs the copy, through the product export and import, a shop at a time.

export const EXPANSION_STORE_LIMITS = {
  perShop: 5,
  /** The most a store's prices are put over its rate (ADR-933). */
  marginPercent: 100,
  /** Collections given a margin of their own (ADR-948). */
  collectionMargins: 10,
  /** Products given a margin of their own (ADR-960). */
  productMargins: 25,
  /** Product types, vendors, tags and metafields' values given a margin of their own (ADR-971, ADR-976, ADR-981). */
  groupMargins: 20,
  /** The longest product type, vendor or tag, as products keep them. */
  groupName: 255,
} as const;

/** A collection's products put a margin of their own over the store's rate (ADR-948). */
export interface ExpansionCollectionMargin {
  collectionId: string;
  marginPercent: number;
}

/** A product put a margin of its own over the store's rate, over its collections' (ADR-960). */
export interface ExpansionProductMargin {
  productId: string;
  marginPercent: number;
}

/** What a margin by product type, vendor (ADR-971), tag (ADR-976) or metafield (ADR-981) matches. */
export const EXPANSION_GROUP_KINDS = ['product_type', 'vendor', 'tag', 'metafield'] as const;
export type ExpansionGroupKind = (typeof EXPANSION_GROUP_KINDS)[number];

/**
 * A product type's or a vendor's products put a margin of their own over the store's rate
 * (ADR-971), after a product's own and its collections', before the store's: `value` matched as
 * the products give it, letter case aside. By a metafield (ADR-981), the products whose metafield
 * `key`, as `namespace.key`, holds `value`.
 */
export interface ExpansionGroupMargin {
  by: ExpansionGroupKind;
  /** The metafield's `namespace.key`, for a margin by metafield alone. */
  key?: string;
  value: string;
  marginPercent: number;
}

/** A product metafield's `namespace.key`, each part as metafields keep it (ADR-981). */
const METAFIELD_KEY = /^[A-Za-z0-9_-]{2,64}\.[A-Za-z0-9_-]{2,64}$/;

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
  /** Whether its rate follows the day's rate between the shops' currencies (ADR-929). */
  followRate: boolean;
  /** What its copied prices are put over its rate, a whole percent, and how rounded (ADR-933). */
  marginPercent: number;
  rounding: PresentmentRounding;
  /**
   * Collections whose products are put a margin of their own over the rate (ADR-948), the first
   * of a product's collections here giving its margin; the store's own for the rest.
   */
  collectionMargins: ExpansionCollectionMargin[];
  /** Products put a margin of their own over the rate (ADR-960), before their collections'. */
  productMargins: ExpansionProductMargin[];
  /** Product types and vendors put a margin of their own, after collections' (ADR-971). */
  groupMargins: ExpansionGroupMargin[];
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
  follow_rate: boolean;
  margin_percent: number;
  rounding: PresentmentRounding;
  collection_margins: ExpansionCollectionMargin[];
  product_margins: ExpansionProductMargin[];
  group_margins: ExpansionGroupMargin[];
  copy_error: string | null;
  failed_at: Date | string | null;
  created_at: Date | string;
};

const COLUMNS = sql`target_shop_id, price_rate::text, synced_at, last_result, auto_copy, follow_rate,
  margin_percent, rounding, collection_margins, product_margins, group_margins, copy_error, failed_at,
  created_at`;

const toRecord = (row: Row): ExpansionStoreRecord => ({
  targetShopId: row.target_shop_id,
  priceRate: row.price_rate.replace(/\.?0+$/, ''),
  syncedAt: row.synced_at === null ? null : toDate(row.synced_at),
  lastResult: row.last_result,
  autoCopy: row.auto_copy,
  followRate: row.follow_rate,
  marginPercent: row.margin_percent,
  rounding: row.rounding,
  collectionMargins: row.collection_margins,
  productMargins: row.product_margins,
  groupMargins: row.group_margins,
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
   * the same currency. A rate given so stops following the day's (ADR-929). The caller checks
   * the same owner holds both.
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
        ON CONFLICT (shop_id, target_shop_id) DO UPDATE
           SET price_rate = EXCLUDED.price_rate, follow_rate = false
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
   * Puts `targetShopId`'s copied prices `marginPercent` over its rate, 0 to 100, and rounds them
   * as `rounding` says (ADR-933): changed, copying as products change copies them again.
   */
  async setPricing(
    tenant: TenantContext,
    targetShopId: string,
    marginPercent: number,
    rounding: string,
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const most = EXPANSION_STORE_LIMITS.marginPercent;
    if (!Number.isInteger(marginPercent) || marginPercent < 0 || marginPercent > most) {
      return failOne(
        ['marginPercent'],
        'INVALID',
        `Margin percent must be a whole number from 0 to ${most}`,
      );
    }
    if (!(PRESENTMENT_ROUNDINGS as readonly string[]).includes(rounding)) {
      return failOne(['rounding'], 'INVALID', 'Rounding must be exact, whole or ninety_nine');
    }
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET rate_changed_at = CASE WHEN margin_percent = ${marginPercent}
                                       AND rounding = ${rounding}
                                      THEN rate_changed_at ELSE now() END,
               margin_percent = ${marginPercent}, rounding = ${rounding}
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`),
    );
    return rows[0]
      ? { ok: true, value: toRecord(rows[0]) }
      : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
  }

  /**
   * Gives the products of each of `margins`' collections, the shop's own, a margin of their own
   * over `targetShopId`'s rate (ADR-948), in the order given: a product in two collections takes
   * the first's. Ten at most, each collection once, each a whole percent from 0 to 100; none
   * leaves the store's own margin for every product. Changed, copying as products change copies
   * them again.
   */
  async setCollectionMargins(
    tenant: TenantContext,
    targetShopId: string,
    margins: readonly ExpansionCollectionMargin[],
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const most = EXPANSION_STORE_LIMITS;
    if (margins.length > most.collectionMargins) {
      return failOne(
        ['margins'],
        'INVALID',
        `${most.collectionMargins} collections at most have a margin of their own`,
      );
    }
    for (const [at, margin] of margins.entries()) {
      const percent = margin.marginPercent;
      if (!Number.isInteger(percent) || percent < 0 || percent > most.marginPercent) {
        return failOne(
          ['margins', String(at), 'marginPercent'],
          'INVALID',
          `Margin percent must be a whole number from 0 to ${most.marginPercent}`,
        );
      }
    }
    const ids = margins.map((margin) => margin.collectionId);
    if (new Set(ids).size !== ids.length) {
      return failOne(['margins'], 'INVALID', 'Give each collection one margin');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: found } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.collections
         WHERE shop_id = ${tenant.shopId} AND id = ANY(${sql.param(ids)}::uuid[])`);
      const known = new Set(found.map((row) => row.id));
      const missing = ids.findIndex((id) => !known.has(id));
      if (missing >= 0) {
        return failOne(
          ['margins', String(missing), 'collectionId'],
          'NOT_FOUND',
          'No such collection',
        );
      }
      const kept = JSON.stringify(
        margins.map(({ collectionId, marginPercent }) => ({ collectionId, marginPercent })),
      );
      const { rows } = await tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET rate_changed_at = CASE WHEN collection_margins = ${kept}::jsonb
                                      THEN rate_changed_at ELSE now() END,
               collection_margins = ${kept}::jsonb
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`);
      return rows[0]
        ? { ok: true as const, value: toRecord(rows[0]) }
        : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
    });
  }

  /**
   * Gives products of the shop's a margin of their own over `targetShopId`'s rate (ADR-960), in
   * place of their collections' and the store's: twenty-five at most, each a whole percent from 0
   * to the store's most. None takes them all away.
   */
  async setProductMargins(
    tenant: TenantContext,
    targetShopId: string,
    margins: readonly ExpansionProductMargin[],
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const most = EXPANSION_STORE_LIMITS;
    if (margins.length > most.productMargins) {
      return failOne(
        ['margins'],
        'INVALID',
        `${most.productMargins} products at most have a margin of their own`,
      );
    }
    for (const [at, margin] of margins.entries()) {
      const percent = margin.marginPercent;
      if (!Number.isInteger(percent) || percent < 0 || percent > most.marginPercent) {
        return failOne(
          ['margins', String(at), 'marginPercent'],
          'INVALID',
          `Margin percent must be a whole number from 0 to ${most.marginPercent}`,
        );
      }
    }
    const ids = margins.map((margin) => margin.productId);
    if (new Set(ids).size !== ids.length) {
      return failOne(['margins'], 'INVALID', 'Give each product one margin');
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: found } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products
         WHERE shop_id = ${tenant.shopId} AND id = ANY(${sql.param(ids)}::uuid[])`);
      const known = new Set(found.map((row) => row.id));
      const missing = ids.findIndex((id) => !known.has(id));
      if (missing >= 0) {
        return failOne(['margins', String(missing), 'productId'], 'NOT_FOUND', 'No such product');
      }
      const kept = JSON.stringify(
        margins.map(({ productId, marginPercent }) => ({ productId, marginPercent })),
      );
      const { rows } = await tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET rate_changed_at = CASE WHEN product_margins = ${kept}::jsonb
                                      THEN rate_changed_at ELSE now() END,
               product_margins = ${kept}::jsonb
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`);
      return rows[0]
        ? { ok: true as const, value: toRecord(rows[0]) }
        : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
    });
  }

  /**
   * Gives the shop's products of each product type or vendor of `margins` a margin of their own
   * over `targetShopId`'s rate (ADR-971), after a product's own and its collections', before the
   * store's: a product of a type given one takes its type's before its vendor's, and its vendor's
   * before its tags' (ADR-976), the first tag in the list it has, and its tags' before its
   * metafields' (ADR-981), the first in the list whose metafield holds the value given. Twenty at
   * most, each type, vendor, tag or metafield's value once, letter case aside; none takes them
   * all away. A type or vendor no product has yet is kept, for the products to come.
   */
  async setGroupMargins(
    tenant: TenantContext,
    targetShopId: string,
    margins: readonly ExpansionGroupMargin[],
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    const most = EXPANSION_STORE_LIMITS;
    if (margins.length > most.groupMargins) {
      return failOne(
        ['margins'],
        'INVALID',
        `${most.groupMargins} product types, vendors, tags and metafields at most have a margin of their own`,
      );
    }
    const kept: ExpansionGroupMargin[] = [];
    for (const [at, margin] of margins.entries()) {
      const value = margin.value.trim();
      if (!EXPANSION_GROUP_KINDS.includes(margin.by)) {
        return failOne(
          ['margins', String(at), 'by'],
          'INVALID',
          'Choose a product type, vendor, tag or metafield',
        );
      }
      const key = margin.by === 'metafield' ? (margin.key ?? '').trim() : undefined;
      if (key !== undefined && !METAFIELD_KEY.test(key)) {
        return failOne(
          ['margins', String(at), 'key'],
          'INVALID',
          'Name the metafield as namespace.key',
        );
      }
      if (value === '' || value.length > most.groupName) {
        return failOne(
          ['margins', String(at), 'value'],
          'INVALID',
          `Name the product type, vendor, tag or value, ${most.groupName} characters at most`,
        );
      }
      const percent = margin.marginPercent;
      if (!Number.isInteger(percent) || percent < 0 || percent > most.marginPercent) {
        return failOne(
          ['margins', String(at), 'marginPercent'],
          'INVALID',
          `Margin percent must be a whole number from 0 to ${most.marginPercent}`,
        );
      }
      if (
        kept.some(
          (each) =>
            each.by === margin.by &&
            each.key === key &&
            each.value.toLowerCase() === value.toLowerCase(),
        )
      ) {
        return failOne(
          ['margins'],
          'INVALID',
          "Give each product type, vendor, tag and metafield's value one margin",
        );
      }
      kept.push(
        key === undefined
          ? { by: margin.by, value, marginPercent: percent }
          : { by: margin.by, key, value, marginPercent: percent },
      );
    }
    const json = JSON.stringify(kept);
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET rate_changed_at = CASE WHEN group_margins = ${json}::jsonb
                                      THEN rate_changed_at ELSE now() END,
               group_margins = ${json}::jsonb
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`),
    );
    return rows[0]
      ? { ok: true, value: toRecord(rows[0]) }
      : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
  }

  /**
   * The margin of each product of the shop's that `margins` give one (ADR-948), by its handle, as
   * its export names it: its first collection's in the list; a product's own (ADR-960) before it,
   * and its type's or vendor's (ADR-971) after it.
   */
  async marginsByHandle(
    tenant: TenantContext,
    margins: readonly ExpansionCollectionMargin[],
    productMargins: readonly ExpansionProductMargin[] = [],
    groupMargins: readonly ExpansionGroupMargin[] = [],
  ): Promise<Map<string, number>> {
    if (margins.length === 0 && productMargins.length === 0 && groupMargins.length === 0) {
      return new Map();
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const chosen =
        groupMargins.length > 0
          ? await groupMarginsByHandleIn(tx, tenant.shopId, groupMargins)
          : new Map<string, number>();
      if (margins.length > 0) {
        for (const [handle, percent] of await marginsByHandleIn(tx, tenant.shopId, margins)) {
          chosen.set(handle, percent);
        }
      }
      if (productMargins.length > 0) {
        const { rows } = await tx.execute<{ id: string; handle: string }>(sql`
          SELECT id, handle FROM catalog.products
           WHERE shop_id = ${tenant.shopId}
             AND id = ANY(${sql.param(productMargins.map((each) => each.productId))}::uuid[])`);
        const handleOf = new Map(rows.map((row) => [row.id, row.handle]));
        for (const margin of productMargins) {
          const handle = handleOf.get(margin.productId);
          if (handle !== undefined) chosen.set(handle, margin.marginPercent);
        }
      }
      return chosen;
    });
  }

  /**
   * Has `targetShopId`'s rate follow the day's rate between the shops' currencies (ADR-929),
   * `rate` being that rate now, as the caller reads it from the feed's; or keep the rate it has,
   * fixed. Refused where Hatti has no day's rate between them.
   */
  async setFollowRate(
    tenant: TenantContext,
    targetShopId: string,
    enabled: boolean,
    rate: string | null,
  ): Promise<MutationResult<ExpansionStoreRecord>> {
    if (enabled && (!rate || !RATE.test(rate) || Number(rate) <= 0)) {
      return failOne(
        ['shopId'],
        'INVALID',
        "Hatti has no day's rate between these shops' currencies: give a rate by hand",
      );
    }
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<Row>(sql`
        UPDATE catalog.expansion_stores
           SET follow_rate = ${enabled},
               ${
                 enabled
                   ? sql`rate_changed_at = CASE WHEN price_rate = ${rate}::numeric
                                              THEN rate_changed_at ELSE now() END,
                         price_rate = ${rate}::numeric`
                   : sql`rate_changed_at = rate_changed_at`
               }
         WHERE shop_id = ${tenant.shopId} AND target_shop_id = ${targetShopId}
        RETURNING ${COLUMNS}`),
    );
    return rows[0]
      ? { ok: true, value: toRecord(rows[0]) }
      : failOne(['shopId'], 'NOT_FOUND', 'No such expansion store');
  }

  /**
   * Keeps the day's rate on a link following it, as the worker read the feed (ADR-929): a rate
   * that changed is kept with when, so that a store copied to as products change is copied again.
   * Whether it changed.
   */
  async followed(shopId: string, targetShopId: string, rate: string, at: Date): Promise<boolean> {
    if (!RATE.test(rate) || Number(rate) <= 0) return false;
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE catalog.expansion_stores
           SET price_rate = ${rate}::numeric, rate_changed_at = ${at.toISOString()}
         WHERE shop_id = ${shopId} AND target_shop_id = ${targetShopId} AND follow_rate
           AND price_rate <> ${rate}::numeric
        RETURNING target_shop_id`),
    );
    return rows.length > 0;
  }

  /** The links following the day's rate, across shops (ADR-929). */
  async following(): Promise<ExpansionCopyDue[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; target_shop_id: string }>(sql`
        SELECT shop_id, target_shop_id FROM catalog.expansion_stores
         WHERE follow_rate ORDER BY shop_id, target_shop_id`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, targetShopId: row.target_shop_id }));
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
   * {@link EXPANSION_AUTO_COPY.quietMs}, or its rate changed since, following the day's
   * (ADR-929); and neither a copy nor a failure within the hour.
   */
  async dueForCopy(at: Date): Promise<ExpansionCopyDue[]> {
    const quiet = new Date(at.getTime() - EXPANSION_AUTO_COPY.quietMs).toISOString();
    const since = new Date(at.getTime() - EXPANSION_AUTO_COPY.everyMs).toISOString();
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; target_shop_id: string }>(sql`
        WITH changed AS (
          SELECT e.shop_id, e.target_shop_id, e.synced_at, e.rate_changed_at,
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
         WHERE (last_change IS NOT NULL AND last_change < ${quiet}
                AND (synced_at IS NULL OR last_change > synced_at))
            OR (rate_changed_at IS NOT NULL
                AND (synced_at IS NULL OR rate_changed_at > synced_at))
         ORDER BY synced_at NULLS FIRST, shop_id, target_shop_id
         LIMIT ${EXPANSION_AUTO_COPY.perSweep}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, targetShopId: row.target_shop_id }));
  }
}

/**
 * The margin of each product of the shop's whose type, vendor (ADR-971), tags (ADR-976) or
 * metafields (ADR-981) `margins` give one, by its handle, in the caller's transaction: its type's
 * before its vendor's, its vendor's before its tags', the first of its tags in `margins`' order,
 * its tags' before its metafields', the first in `margins`' order; letter case aside. A
 * metafield's value is matched as kept, so a list's whole value, not one of its items.
 */
async function groupMarginsByHandleIn(
  tx: Tx,
  shopId: string,
  margins: readonly ExpansionGroupMargin[],
): Promise<Map<string, number>> {
  const of = (by: ExpansionGroupKind) =>
    new Map(
      margins
        .filter((margin) => margin.by === by)
        .map((margin) => [margin.value.toLowerCase(), margin.marginPercent]),
    );
  const types = of('product_type');
  const vendors = of('vendor');
  const tags = of('tag');
  // Each metafield's value as `namespace.key`, a line break, then its value, letter case aside.
  const fields = new Map(
    margins
      .filter((margin) => margin.by === 'metafield' && margin.key)
      .map((margin) => [`${margin.key}\n${margin.value.toLowerCase()}`, margin.marginPercent]),
  );
  const keys = [...new Set([...fields.keys()].map((field) => field.split('\n')[0]!))];
  const { rows } = await tx.execute<{
    handle: string;
    product_type: string | null;
    vendor: string | null;
    tags: string[];
    fields: string[];
  }>(sql`
    SELECT p.handle, p.product_type, p.vendor, p.tags,
           COALESCE((SELECT array_agg(m.namespace || '.' || m.key || E'\n' || lower(btrim(m.value)))
                       FROM catalog.metafields m
                      WHERE m.shop_id = p.shop_id AND m.product_id = p.id
                        AND m.namespace || '.' || m.key = ANY(${sql.param(keys)}::text[])),
                    '{}') AS fields
      FROM catalog.products p
     WHERE p.shop_id = ${shopId}
       AND (lower(btrim(p.product_type)) = ANY(${sql.param([...types.keys()])}::text[])
            OR lower(btrim(p.vendor)) = ANY(${sql.param([...vendors.keys()])}::text[])
            OR EXISTS (SELECT 1 FROM unnest(p.tags) AS tag
                        WHERE lower(btrim(tag)) = ANY(${sql.param([...tags.keys()])}::text[]))
            OR EXISTS (SELECT 1 FROM catalog.metafields m
                        WHERE m.shop_id = p.shop_id AND m.product_id = p.id
                          AND m.namespace || '.' || m.key || E'\n' || lower(btrim(m.value))
                              = ANY(${sql.param([...fields.keys()])}::text[])))`);
  const chosen = new Map<string, number>();
  for (const row of rows) {
    const own = new Set(row.tags.map((tag) => tag.trim().toLowerCase()));
    const tagged = [...tags].find(([tag]) => own.has(tag))?.[1];
    const held = new Set(row.fields);
    const fielded = [...fields].find(([field]) => held.has(field))?.[1];
    const percent =
      types.get(row.product_type?.trim().toLowerCase() ?? '') ??
      vendors.get(row.vendor?.trim().toLowerCase() ?? '') ??
      tagged ??
      fielded;
    if (percent !== undefined) chosen.set(row.handle, percent);
  }
  return chosen;
}

/** {@link ExpansionStoreService.marginsByHandle}, in the caller's transaction. */
async function marginsByHandleIn(
  tx: Tx,
  shopId: string,
  margins: readonly ExpansionCollectionMargin[],
): Promise<Map<string, number>> {
  const { rows } = await tx.execute<{ handle: string; collection_id: string }>(sql`
    SELECT p.handle, cp.collection_id
      FROM catalog.collection_products cp
      JOIN catalog.products p ON p.shop_id = cp.shop_id AND p.id = cp.product_id
     WHERE cp.shop_id = ${shopId}
       AND cp.collection_id = ANY(${sql.param(margins.map((margin) => margin.collectionId))}::uuid[])`);
  const order = new Map(margins.map((margin, at) => [margin.collectionId, at]));
  const chosen = new Map<string, number>();
  for (const row of rows) {
    const at = order.get(row.collection_id)!;
    const before = chosen.get(row.handle);
    if (before === undefined || at < before) chosen.set(row.handle, at);
  }
  return new Map([...chosen].map(([handle, at]) => [handle, margins[at]!.marginPercent]));
}

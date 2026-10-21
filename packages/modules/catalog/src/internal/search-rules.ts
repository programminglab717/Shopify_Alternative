import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { loadProducts } from './product-store.js';
import type { ProductRecord } from './records.js';

// What a storefront's search shows first, or leaves out, for a term (SRC-04, ADR-692): a shop
// pins its Eid edit to the top of "eid", in its order, and hides the last season's from it, as
// Shopify's Search & Discovery boosts and hides products for a search.

/** Events of a shop's search rules. Payloads are thin: fetch current state through the API. */
export const SearchRuleEvents = {
  /** A term's products pinned or hidden were set or changed. */
  Updated: 'search_rule.updated',
  /** A term's rule was taken away: its search is as it finds. */
  Deleted: 'search_rule.deleted',
} as const;

export interface SearchRuleUpdatedPayload {
  pinned: number;
  hidden: number;
}

/**
 * How many terms a shop keeps rules for, how long a term may be and how many words it has (the
 * search reads no more), and how many products a term pins and hides.
 */
export const SEARCH_RULE_LIMITS = { rules: 200, query: 100, words: 10, pinned: 10, hidden: 50 };

/** A term's rule, as the shop wrote it. */
export interface SearchRuleRecord {
  id: string;
  /** The term as the shop wrote it. */
  query: string;
  /** Products shown first, in this order: those the shop has now. */
  pinned: string[];
  /** Products left out: those the shop has now. */
  hidden: string[];
  updatedAt: Date;
}

/** A term as the search folds it: its words, each folded, between single spaces. */
export function searchRuleKey(query: string): string {
  return searchKey(query).split(' ').filter(Boolean).join(' ');
}

/**
 * The products the rule for the term `key` (as {@link searchRuleKey} folds it) pins and hides, in
 * the caller's transaction `tx`; null when the shop keeps none for it.
 */
export async function searchRuleIn(
  tx: Tx,
  shopId: string,
  key: string,
): Promise<{ pinned: string[]; hidden: string[] } | null> {
  const { rows } = await tx.execute<{ pinned: string[]; hidden: string[] }>(sql`
    SELECT pinned, hidden FROM catalog.search_rules
     WHERE shop_id = ${shopId} AND query_key = ${key}`);
  return rows[0] ?? null;
}

type Row = {
  id: string;
  query: string;
  pinned: string[];
  hidden: string[];
  updated_at: Date;
};

/** A row with only the products the shop still has, in its order. */
async function recordsOf(tx: Tx, shopId: string, rows: readonly Row[]) {
  const ids = [...new Set(rows.flatMap((row) => [...row.pinned, ...row.hidden]))];
  const { rows: found } =
    ids.length === 0
      ? { rows: [] }
      : await tx.execute<{ id: string }>(sql`
          SELECT id FROM catalog.products
           WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])`);
  const kept = new Set(found.map((row) => row.id));
  return rows.map((row): SearchRuleRecord => ({
    id: row.id,
    query: row.query,
    pinned: row.pinned.filter((id) => kept.has(id)),
    hidden: row.hidden.filter((id) => kept.has(id)),
    updatedAt: row.updated_at,
  }));
}

/** What a shop's search shows first, or leaves out, term by term (SRC-04, ADR-692). */
@Injectable()
export class SearchRuleService {
  constructor(private readonly db: Database) {}

  /** The shop's rules, by their terms. */
  async list(tenant: TenantContext): Promise<SearchRuleRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<Row>(sql`
        SELECT id, query, pinned, hidden, updated_at FROM catalog.search_rules
         WHERE shop_id = ${tenant.shopId}
         ORDER BY query_key`);
      return recordsOf(tx, tenant.shopId, rows);
    });
  }

  /**
   * Pins `pinned` to the top of the search for `query`, in their order, and leaves `hidden` out
   * of it, in place of what the term's rule said; a term written as another's folds is the same
   * term. The rule as it is now.
   */
  async set(
    tenant: TenantContext,
    query: string,
    pinned: readonly string[],
    hidden: readonly string[],
  ): Promise<MutationResult<SearchRuleRecord>> {
    const check = new InputChecker();
    const term = check.text(['query'], query, { required: true, max: SEARCH_RULE_LIMITS.query });
    const key = term === null ? '' : searchRuleKey(term);
    if (term !== null && key === '') {
      check.addMessage(['query'], 'INVALID', 'A search term must have a word');
    } else if (key.split(' ').length > SEARCH_RULE_LIMITS.words) {
      check.addMessage(
        ['query'],
        'TOO_LONG',
        `A search term has ${SEARCH_RULE_LIMITS.words} words at most, as the search reads them`,
      );
    }
    const lists = { pinnedProductIds: pinned, hiddenProductIds: hidden } as const;
    const max = {
      pinnedProductIds: SEARCH_RULE_LIMITS.pinned,
      hiddenProductIds: SEARCH_RULE_LIMITS.hidden,
    } as const;
    const seen = new Set<string>();
    for (const [field, ids] of Object.entries(lists) as [keyof typeof lists, readonly string[]][]) {
      if (ids.length > max[field]) {
        check.addMessage(
          [field],
          'TOO_MANY',
          field === 'pinnedProductIds'
            ? `A search pins ${SEARCH_RULE_LIMITS.pinned} products at most`
            : `A search hides ${SEARCH_RULE_LIMITS.hidden} products at most`,
        );
      }
      ids.forEach((id, at) => {
        if (seen.has(id)) {
          check.addMessage(
            [field, String(at)],
            'TAKEN',
            'The product is pinned or hidden for this search already',
          );
        }
        seen.add(id);
      });
    }
    if (pinned.length === 0 && hidden.length === 0) {
      check.addMessage(['pinnedProductIds'], 'BLANK', 'Pin or hide a product at least');
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows: found } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...seen])}::uuid[])`);
      const known = new Set(found.map((row) => row.id));
      const missing = new InputChecker();
      for (const [field, ids] of Object.entries(lists)) {
        ids.forEach((id, at) => {
          if (!known.has(id))
            missing.addMessage([field, String(at)], 'NOT_FOUND', 'Product not found');
        });
      }
      if (!missing.ok) return { ok: false, errors: missing.errors };
      // Rules are counted under the shop's lock on them, so two new terms can't pass the limit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`search_rules:${shopId}`}, 0))`,
      );
      const { rows: before } = await tx.execute<{ id: string; total: number }>(sql`
        SELECT (SELECT id FROM catalog.search_rules
                 WHERE shop_id = ${shopId} AND query_key = ${key}) AS id,
               (SELECT count(*)::int FROM catalog.search_rules WHERE shop_id = ${shopId}) AS total`);
      if (!before[0]!.id && before[0]!.total >= SEARCH_RULE_LIMITS.rules) {
        return failOne<SearchRuleRecord>(
          ['query'],
          'TOO_MANY',
          `A shop keeps rules for ${SEARCH_RULE_LIMITS.rules} searches at most`,
        );
      }
      const { rows } = await tx.execute<Row>(sql`
        INSERT INTO catalog.search_rules (shop_id, id, query, query_key, pinned, hidden)
        VALUES (${shopId}, ${newId()}, ${term}, ${key}, ${sql.param([...pinned])}::uuid[],
                ${sql.param([...hidden])}::uuid[])
        ON CONFLICT (shop_id, query_key) DO UPDATE
          SET query = EXCLUDED.query, pinned = EXCLUDED.pinned, hidden = EXCLUDED.hidden,
              updated_at = now()
        RETURNING id, query, pinned, hidden, updated_at`);
      const row = rows[0]!;
      await appendEvent<SearchRuleUpdatedPayload>(tx, shopId, {
        type: SearchRuleEvents.Updated,
        aggregateType: 'search_rule',
        aggregateId: row.id,
        payload: { pinned: pinned.length, hidden: hidden.length },
      });
      return { ok: true, value: (await recordsOf(tx, shopId, [row]))[0]! };
    });
  }

  /** The products of `ids` the shop has, as records, by ID. */
  async productsOf(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, ProductRecord>> {
    if (ids.length === 0) return new Map();
    const records = await this.db.tenant(tenant.shopId, (tx) =>
      loadProducts(tx, tenant.shopId, {
        where: sql`p.id = ANY(${sql.param([...new Set(ids)])}::uuid[])`,
      }),
    );
    return new Map(records.map((record) => [record.id, record]));
  }

  /** Takes a term's rule away: its search shows what it finds. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        DELETE FROM catalog.search_rules WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`);
      if (!rows[0]) return failOne<string>(['id'], 'NOT_FOUND', 'Search rule not found');
      await appendEvent(tx, tenant.shopId, {
        type: SearchRuleEvents.Deleted,
        aggregateType: 'search_rule',
        aggregateId: id,
        payload: {},
      });
      return { ok: true, value: id };
    });
  }
}

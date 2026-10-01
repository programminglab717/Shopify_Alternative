import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import {
  OrderEvents,
  type SavedSearchCreatedPayload,
  type SavedSearchDeletedPayload,
  type SavedSearchUpdatedPayload,
} from './events.js';
import { parseOrderSearch } from './order-filter.js';
import type { Page, SavedSearchRecord } from './records.js';
import { LIMITS } from './rules.js';
import { savedSearches, type SavedSearchRow } from './schema.js';

export interface SavedSearchInput {
  name: string;
  /** As orders(query:) takes it: words, and filters among them (ADR-118). */
  query: string;
}

/** Fields left out stay as they are. */
export interface SavedSearchUpdateInput {
  name?: string | null;
  query?: string | null;
}

const NAME_TAKEN = 'A saved search with this name already exists';

function toSavedSearchRecord(row: SavedSearchRow): SavedSearchRecord {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Saved searches of the orders list (ORD-01, ADR-119): searches the shop keeps by name, shop-wide,
 * as Shopify's saved searches, for its staff to open the views they use every day. Each keeps its
 * query, which orders(query:) takes as it is; it is checked as that search checks it when saved,
 * so a saved search never names a filter the list doesn't know.
 */
@Injectable()
export class SavedSearchService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: SavedSearchInput,
  ): Promise<MutationResult<SavedSearchRecord>> {
    const check = new InputChecker();
    const name = checkName(check, input.name);
    const query = checkQuery(check, input.query);
    if (!check.ok || !name || !query) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        // Counted under a lock, so that two saved at once can't both pass the limit.
        await lockSearches(tx, tenant.shopId);
        const [kept] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(savedSearches)
          .where(eq(savedSearches.shopId, tenant.shopId));
        if (kept!.count >= LIMITS.savedSearches) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop keeps at most ${LIMITS.savedSearches} saved searches of its orders`,
          );
        }
        const [row] = await tx
          .insert(savedSearches)
          .values({ shopId: tenant.shopId, id: newId(), name, query })
          .returning();
        await appendEvent<SavedSearchCreatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.SavedSearchCreated,
          aggregateType: 'saved_search',
          aggregateId: row!.id,
          payload: { version: row!.version },
        });
        return { ok: true, value: toSavedSearchRecord(row!) };
      }),
    );
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: SavedSearchUpdateInput,
  ): Promise<MutationResult<SavedSearchRecord>> {
    const check = new InputChecker();
    const name = input.name === undefined ? undefined : checkName(check, input.name);
    const query = input.query === undefined ? undefined : checkQuery(check, input.query);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const where = and(eq(savedSearches.shopId, tenant.shopId), eq(savedSearches.id, id));
        const [current] = await tx.select().from(savedSearches).where(where).for('update');
        if (!current) return failOne(['input', 'id'], 'NOT_FOUND', 'Saved search not found');
        const changes: Partial<Pick<SavedSearchRow, 'name' | 'query'>> = {};
        if (name && name !== current.name) changes.name = name;
        if (query && query !== current.query) changes.query = query;
        const changed = Object.keys(changes);
        if (changed.length === 0) return { ok: true, value: toSavedSearchRecord(current) };
        const [row] = await tx
          .update(savedSearches)
          .set({ ...changes, version: sql`${savedSearches.version} + 1`, updatedAt: sql`now()` })
          .where(where)
          .returning();
        await appendEvent<SavedSearchUpdatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.SavedSearchUpdated,
          aggregateType: 'saved_search',
          aggregateId: id,
          payload: { changed, version: row!.version },
        });
        return { ok: true, value: toSavedSearchRecord(row!) };
      }),
    );
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [deleted] = await tx
        .delete(savedSearches)
        .where(and(eq(savedSearches.shopId, tenant.shopId), eq(savedSearches.id, id)))
        .returning({ id: savedSearches.id });
      if (!deleted) return failOne(['input', 'id'], 'NOT_FOUND', 'Saved search not found');
      await appendEvent<SavedSearchDeletedPayload>(tx, tenant.shopId, {
        type: OrderEvents.SavedSearchDeleted,
        aggregateType: 'saved_search',
        aggregateId: id,
        payload: {},
      });
      return { ok: true, value: deleted };
    });
  }

  /** The shop's saved searches of its orders, oldest first, as their tabs were added. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<Page<SavedSearchRecord>> {
    const conditions: SQL[] = [eq(savedSearches.shopId, tenant.shopId)];
    if (options.after) conditions.push(gt(savedSearches.id, options.after));
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(savedSearches)
        .where(and(...conditions))
        .orderBy(asc(savedSearches.id))
        .limit(options.first + 1),
    );
    return {
      items: rows.slice(0, options.first).map(toSavedSearchRecord),
      hasNextPage: rows.length > options.first,
    };
  }

  /** A name another saved search has is refused, whichever transaction gets there first. */
  async #unique(
    write: () => Promise<MutationResult<SavedSearchRecord>>,
  ): Promise<MutationResult<SavedSearchRecord>> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, 'saved_searches_name_key')) {
        return failOne(['input', 'name'], 'TAKEN', NAME_TAKEN);
      }
      throw error;
    }
  }
}

function checkName(check: InputChecker, name: string | null | undefined): string | null {
  return check.text(['input', 'name'], name, { required: true, max: LIMITS.savedSearchName });
}

/** The query, if orders(query:) takes it; it says what is wrong otherwise. */
function checkQuery(check: InputChecker, query: string | null | undefined): string | null {
  const text = check.text(['input', 'query'], query, {
    required: true,
    max: LIMITS.savedSearchQuery,
  });
  if (!text) return null;
  const search = parseOrderSearch(text);
  if (!search.ok) {
    check.addMessage(['input', 'query'], 'INVALID', search.error);
    return null;
  }
  return text;
}

/** Holds the shop's saved searches still while one is added, for the count. */
async function lockSearches(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`saved_searches:${shopId}`}, 0))`,
  );
}

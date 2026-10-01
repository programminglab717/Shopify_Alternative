import {
  InputChecker,
  failOne,
  type MutationResult,
  type SearchParse,
  type TenantContext,
} from '@hatti/api';
import { parseProductSearch } from '@hatti/catalog/public';
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
import { parseDraftSearch } from './draft-filter.js';
import { parseOrderSearch } from './order-filter.js';
import type { Page, SavedSearchRecord } from './records.js';
import { LIMITS } from './rules.js';
import { savedSearches, type SavedSearchRow, type SavedSearchTypeValue } from './schema.js';

export interface SavedSearchInput {
  /** The list it searches (ADR-124). */
  resourceType: SavedSearchTypeValue;
  name: string;
  /** As its list's search takes it: words, and filters among them (ADR-118). */
  query: string;
}

/** Fields left out stay as they are. */
export interface SavedSearchUpdateInput {
  name?: string | null;
  query?: string | null;
}

const NAME_TAKEN = 'A saved search of this list with this name already exists';

/** Each list's search, which checks the queries saved of it, and what the list holds. */
const LISTS: Record<
  SavedSearchTypeValue,
  { parse: (query: string) => SearchParse<string>; noun: string }
> = {
  order: { parse: parseOrderSearch, noun: 'orders' },
  draft_order: { parse: parseDraftSearch, noun: 'drafts' },
  product: { parse: parseProductSearch, noun: 'products' },
};

/** A saved search's query split as its list's search reads it (ADR-124). */
export function parseSavedSearch(
  resourceType: SavedSearchTypeValue,
  query: string,
): SearchParse<string> {
  return LISTS[resourceType].parse(query);
}

function toSavedSearchRecord(row: SavedSearchRow): SavedSearchRecord {
  return {
    id: row.id,
    resourceType: row.resourceType,
    name: row.name,
    query: row.query,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Saved searches of the shop's lists (ORD-01, ADR-119, ADR-124): searches it keeps by name,
 * shop-wide, as Shopify's saved searches, for its staff to open the views they use every day: of
 * its orders, its drafts and its products. Each keeps its query, which its list's search takes as
 * it is; it is checked as that search checks it when saved, so a saved search never names a
 * filter its list doesn't know.
 */
@Injectable()
export class SavedSearchService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: SavedSearchInput,
  ): Promise<MutationResult<SavedSearchRecord>> {
    const { resourceType } = input;
    const check = new InputChecker();
    const name = checkName(check, input.name);
    const query = checkQuery(check, resourceType, input.query);
    if (!check.ok || !name || !query) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        // Counted under a lock, so that two saved at once can't both pass the limit.
        await lockSearches(tx, tenant.shopId);
        const [kept] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(savedSearches)
          .where(
            and(
              eq(savedSearches.shopId, tenant.shopId),
              eq(savedSearches.resourceType, resourceType),
            ),
          );
        if (kept!.count >= LIMITS.savedSearches) {
          return failOne(
            ['input'],
            'TOO_MANY',
            `A shop keeps at most ${LIMITS.savedSearches} saved searches of its ${LISTS[resourceType].noun}`,
          );
        }
        const [row] = await tx
          .insert(savedSearches)
          .values({ shopId: tenant.shopId, id: newId(), resourceType, name, query })
          .returning();
        await appendEvent<SavedSearchCreatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.SavedSearchCreated,
          aggregateType: 'saved_search',
          aggregateId: row!.id,
          payload: { resourceType, version: row!.version },
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
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#unique(() =>
      this.db.tenant(tenant.shopId, async (tx) => {
        const where = and(eq(savedSearches.shopId, tenant.shopId), eq(savedSearches.id, id));
        const [current] = await tx.select().from(savedSearches).where(where).for('update');
        if (!current) return failOne(['input', 'id'], 'NOT_FOUND', 'Saved search not found');
        // Its query is checked by its own list's search.
        const query =
          input.query === undefined
            ? undefined
            : checkQuery(check, current.resourceType, input.query);
        if (!check.ok) return { ok: false, errors: check.errors };
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

  /** Which list a saved search of the shop's searches; null if it has none by that ID. */
  async resourceTypeOf(tenant: TenantContext, id: string): Promise<SavedSearchTypeValue | null> {
    const [row] = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select({ resourceType: savedSearches.resourceType })
        .from(savedSearches)
        .where(and(eq(savedSearches.shopId, tenant.shopId), eq(savedSearches.id, id))),
    );
    return row?.resourceType ?? null;
  }

  /** The shop's saved searches of one of its lists, oldest first, as their tabs were added. */
  async list(
    tenant: TenantContext,
    resourceType: SavedSearchTypeValue,
    options: { first: number; after?: string | null },
  ): Promise<Page<SavedSearchRecord>> {
    const conditions: SQL[] = [
      eq(savedSearches.shopId, tenant.shopId),
      eq(savedSearches.resourceType, resourceType),
    ];
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

/** The query, if its list's search takes it; it says what is wrong otherwise. */
function checkQuery(
  check: InputChecker,
  resourceType: SavedSearchTypeValue,
  query: string | null | undefined,
): string | null {
  const text = check.text(['input', 'query'], query, {
    required: true,
    max: LIMITS.savedSearchQuery,
  });
  if (!text) return null;
  const search = parseSavedSearch(resourceType, text);
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

import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, ilike, or, sql, type SQL } from 'drizzle-orm';
import { OnlineStoreEvents, type UrlRedirectChangedPayload } from './events.js';
import { REDIRECT_LIMIT, redirectPath, redirectTarget } from './redirect-paths.js';
import type { Page, UrlRedirectRecord } from './records.js';
import { urlRedirects, type UrlRedirectRow } from './schema.js';

export interface UrlRedirectInput {
  path?: string | null;
  target?: string | null;
}

/**
 * A shop's URL redirects (ADR-052), as Shopify's: from an address the shop has no page at, such
 * as its Shopify store's `/products/old-lawn`, to another, on the storefront or elsewhere. The
 * storefront follows one only where it would otherwise answer 404, so a redirect never hides a
 * page. A path has one redirect.
 */
@Injectable()
export class UrlRedirectService {
  constructor(private readonly db: Database) {}

  /** The shop's redirects, oldest first; with `query`, those whose path or target has it. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; query?: string | null },
  ): Promise<Page<UrlRedirectRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const conditions: SQL[] = [eq(urlRedirects.shopId, tenant.shopId)];
      if (options.after) conditions.push(gt(urlRedirects.id, options.after));
      // No path or target has control characters, and Postgres refuses some.
      const query = options.query
        ?.replace(/\p{Cc}/gu, '')
        .trim()
        .toLowerCase();
      if (query) {
        const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        conditions.push(or(ilike(urlRedirects.path, like), ilike(urlRedirects.target, like))!);
      }
      const rows = await tx
        .select()
        .from(urlRedirects)
        .where(and(...conditions))
        .orderBy(asc(urlRedirects.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<UrlRedirectRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id);
      return row ? toRecord(row) : null;
    });
  }

  /** A redirect from `path` to `target`. Records `url_redirect.created`. */
  async create(
    tenant: TenantContext,
    input: UrlRedirectInput,
  ): Promise<MutationResult<UrlRedirectRecord>> {
    const checked = checkRedirect(input, { required: true });
    if (!checked.ok) return checked;
    const { path, target } = checked.value as { path: string; target: string };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [counts] = await tx
        .select({ total: count() })
        .from(urlRedirects)
        .where(eq(urlRedirects.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= REDIRECT_LIMIT) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${REDIRECT_LIMIT} redirects`);
      }
      const [row] = await tx
        .insert(urlRedirects)
        .values({ shopId: tenant.shopId, id: newId(), path, target })
        .onConflictDoNothing()
        .returning();
      if (!row) return failOne(['path'], 'TAKEN', `${path} has a redirect already`);
      await recordEvent(tx, OnlineStoreEvents.UrlRedirectCreated, row);
      return { ok: true, value: toRecord(row) };
    });
  }

  /** Changes the redirect's path or target, those given. Records `url_redirect.updated`. */
  async update(
    tenant: TenantContext,
    id: string,
    input: UrlRedirectInput,
  ): Promise<MutationResult<UrlRedirectRecord>> {
    const checked = checkRedirect(input, { required: false });
    if (!checked.ok) return checked;
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const row = await this.#find(tx, tenant.shopId, id, { lock: true });
        if (!row) return failOne(['id'], 'NOT_FOUND', 'URL redirect not found');
        const path = checked.value.path ?? row.path;
        const target = checked.value.target ?? row.target;
        if (sendsBack(path, target)) {
          return failOne(['target'], 'INVALID', `${target} would send shoppers back to ${path}`);
        }
        if (path === row.path && target === row.target) return { ok: true, value: toRecord(row) };
        const [updated] = await tx
          .update(urlRedirects)
          .set({ path, target, updatedAt: sql`now()` })
          .where(and(eq(urlRedirects.shopId, tenant.shopId), eq(urlRedirects.id, id)))
          .returning();
        await recordEvent(tx, OnlineStoreEvents.UrlRedirectUpdated, updated!);
        return { ok: true, value: toRecord(updated!) };
      });
    } catch (error) {
      // Another redirect has the path: the transaction is undone whole.
      if (isUniqueViolation(error, 'url_redirects_path_key')) {
        return failOne(['path'], 'TAKEN', `${checked.value.path} has a redirect already`);
      }
      throw error;
    }
  }

  /** Deletes the redirect: its path answers 404 again. Records `url_redirect.deleted`. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(urlRedirects)
        .where(and(eq(urlRedirects.shopId, tenant.shopId), eq(urlRedirects.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'URL redirect not found');
      await recordEvent(tx, OnlineStoreEvents.UrlRedirectDeleted, row);
      return { ok: true, value: { id } };
    });
  }

  async #find(
    tx: Tx,
    shopId: string,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<UrlRedirectRow | undefined> {
    const query = tx
      .select()
      .from(urlRedirects)
      .where(and(eq(urlRedirects.shopId, shopId), eq(urlRedirects.id, id)));
    const [row] = options.lock ? await query.for('update') : await query;
    return row;
  }
}

/**
 * Sends shoppers from a page's old address to where it is now, in the caller's transaction `tx`,
 * as Shopify's `redirectNewHandle` does (ADR-053): a redirect from `from` to `to`, in place of one
 * `from` had; redirects that sent shoppers to `from` send them to `to` instead, so none goes the
 * long way round; and one from `to`, where the page is now, goes. With `from` the same as `to`,
 * the page is back where it was, and only that last is done. Both are paths in `redirectPath`'s
 * form, such as /products/lawn. Returns false when the shop keeps as many redirects as it may, so
 * none from `from` could be added; the rest is done still.
 */
export async function redirectMoved(
  tx: Tx,
  shopId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const [atTo] = await tx
    .delete(urlRedirects)
    .where(and(eq(urlRedirects.shopId, shopId), eq(urlRedirects.path, to)))
    .returning();
  if (atTo) await recordEvent(tx, OnlineStoreEvents.UrlRedirectDeleted, atTo);
  if (from === to) return true;

  // Those sending shoppers to the old address, with a query or a fragment or without.
  const pointing = await tx
    .select()
    .from(urlRedirects)
    .where(
      and(
        eq(urlRedirects.shopId, shopId),
        or(
          eq(urlRedirects.target, from),
          sql`starts_with(${urlRedirects.target}, ${`${from}?`})`,
          sql`starts_with(${urlRedirects.target}, ${`${from}#`})`,
        ),
      ),
    )
    .for('update');
  for (const row of pointing) {
    const [updated] = await tx
      .update(urlRedirects)
      .set({ target: `${to}${row.target.slice(from.length)}`, updatedAt: sql`now()` })
      .where(and(eq(urlRedirects.shopId, shopId), eq(urlRedirects.id, row.id)))
      .returning();
    await recordEvent(tx, OnlineStoreEvents.UrlRedirectUpdated, updated!);
  }

  const [existing] = await tx
    .select()
    .from(urlRedirects)
    .where(and(eq(urlRedirects.shopId, shopId), eq(urlRedirects.path, from)))
    .for('update');
  if (existing) {
    if (existing.target === to) return true;
    const [updated] = await tx
      .update(urlRedirects)
      .set({ target: to, updatedAt: sql`now()` })
      .where(and(eq(urlRedirects.shopId, shopId), eq(urlRedirects.id, existing.id)))
      .returning();
    await recordEvent(tx, OnlineStoreEvents.UrlRedirectUpdated, updated!);
    return true;
  }
  const [counts] = await tx
    .select({ total: count() })
    .from(urlRedirects)
    .where(eq(urlRedirects.shopId, shopId));
  if ((counts?.total ?? 0) >= REDIRECT_LIMIT) return false;
  const [row] = await tx
    .insert(urlRedirects)
    .values({ shopId, id: newId(), path: from, target: to })
    .returning();
  await recordEvent(tx, OnlineStoreEvents.UrlRedirectCreated, row!);
  return true;
}

/**
 * Every redirect of the shop's, by path, in the caller's transaction `tx`: for read models built
 * outside the module, such as the storefront's.
 */
export async function shopRedirectsOf(
  tx: Tx,
  shopId: string,
): Promise<{ path: string; target: string }[]> {
  return tx
    .select({ path: urlRedirects.path, target: urlRedirects.target })
    .from(urlRedirects)
    .where(eq(urlRedirects.shopId, shopId))
    .orderBy(asc(urlRedirects.path));
}

/** The path and target given, as kept, or what is wrong with them. */
function checkRedirect(
  input: UrlRedirectInput,
  options: { required: boolean },
): MutationResult<{ path?: string; target?: string }> {
  const check = new InputChecker();
  const value: { path?: string; target?: string } = {};
  if ((input.path ?? null) !== null || options.required) {
    const path = redirectPath(input.path ?? '');
    if (path === null) {
      check.addMessage(
        ['path'],
        'INVALID',
        'Enter a path on the shop other than its home page, such as /products/old-lawn',
      );
    } else value.path = path;
  }
  if ((input.target ?? null) !== null || options.required) {
    const target = redirectTarget(input.target ?? '');
    if (target === null) {
      check.addMessage(
        ['target'],
        'INVALID',
        'Enter a path on the shop, such as /collections/lawn, or an https:// address',
      );
    } else value.target = target;
  }
  if (!check.ok) return fail(check.errors);
  if (value.path && value.target && sendsBack(value.path, value.target)) {
    return failOne(
      ['target'],
      'INVALID',
      `${value.target} would send shoppers back to ${value.path}`,
    );
  }
  return { ok: true, value };
}

/** Whether a redirect's target is its own path, however written. */
function sendsBack(path: string, target: string): boolean {
  return target.startsWith('/') && redirectPath(target) === path;
}

async function recordEvent(tx: Tx, type: string, row: UrlRedirectRow): Promise<void> {
  await appendEvent<UrlRedirectChangedPayload>(tx, row.shopId, {
    type,
    aggregateType: 'url_redirect',
    aggregateId: row.id,
    payload: { path: row.path, target: row.target },
  });
}

function toRecord(row: UrlRedirectRow): UrlRedirectRecord {
  return {
    id: row.id,
    path: row.path,
    target: row.target,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

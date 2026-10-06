import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { CsvError, parseCsv, toCsv } from '@hatti/csv';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  OnlineStoreEvents,
  type UrlRedirectChangedPayload,
  type UrlRedirectsImportedPayload,
  type UrlRedirectsMovedPayload,
} from './events.js';
import { REDIRECT_LIMIT, redirectPath, redirectTarget } from './redirect-paths.js';
import type { Page, UrlRedirectRecord } from './records.js';
import { urlRedirects, type UrlRedirectRow } from './schema.js';

export interface UrlRedirectInput {
  path?: string | null;
  target?: string | null;
}

/** How much one import of redirects takes. */
export const REDIRECT_IMPORT_LIMITS = {
  /** Characters in the file. */
  csv: 1_500_000,
  /** Rows: every redirect a shop may keep. */
  rows: REDIRECT_LIMIT,
  /** Row errors the result lists; it counts them all. */
  rowErrors: 100,
} as const;

/** The headings of Shopify's redirects export, which the import reads and the export writes. */
export const REDIRECT_CSV_HEADINGS = ['Redirect from', 'Redirect to'] as const;

/** A row of an import that did not go in, and why. */
export interface RedirectImportRowError {
  /** Its row in the file, the headings being row 1. */
  row: number;
  /** The file's heading, or null for the row as a whole. */
  column: string | null;
  message: string;
}

/** What an import did, or would do in a dry run. */
export interface RedirectImportResult {
  /** Rows under the headings. */
  rows: number;
  /** Redirects made, or that would be. */
  created: number;
  /** Rows left as they are: the shop has a redirect from their paths already. */
  skipped: number;
  rowErrors: RedirectImportRowError[];
  rowErrorCount: number;
  dryRun: boolean;
}

/** Rows inserted at a time, and paths looked up. */
const IMPORT_BATCH = 500;

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

  /**
   * Redirects from a file as Shopify exports them, Redirect from and Redirect to, each checked as
   * `create` checks one (ONB-05). A path the shop has a redirect from already is left as it is;
   * rows that fail are said by row and column, and the rest go in, in one transaction, with one
   * `url_redirects.imported` event. `dryRun` checks and counts, changing nothing.
   */
  async import(
    tenant: TenantContext,
    csv: string,
    options: { dryRun?: boolean } = {},
  ): Promise<MutationResult<RedirectImportResult>> {
    const dryRun = options.dryRun ?? false;
    if (csv.trim() === '') return failOne(['csv'], 'BLANK', 'The file is empty');
    if (csv.length > REDIRECT_IMPORT_LIMITS.csv) {
      return failOne(
        ['csv'],
        'TOO_LONG',
        `The file is too long (at most ${REDIRECT_IMPORT_LIMITS.csv.toLocaleString('en')} characters)`,
      );
    }
    let table: string[][];
    try {
      table = parseCsv(csv);
    } catch (error) {
      if (!(error instanceof CsvError)) throw error;
      return failOne(['csv'], 'INVALID', `The file is not CSV: ${error.message}`);
    }
    const [header, ...records] = table;
    if (!header || records.length === 0) {
      return failOne(['csv'], 'BLANK', 'The file has no redirects under its headings');
    }
    if (records.length > REDIRECT_IMPORT_LIMITS.rows) {
      return failOne(
        ['csv'],
        'TOO_MANY',
        `The file has ${records.length} rows; a shop keeps at most ${REDIRECT_LIMIT.toLocaleString('en')} redirects`,
      );
    }
    const headings = header.map((heading) => heading.trim().toLowerCase().replace(/\s+/g, ' '));
    const from = headings.findIndex((heading) => heading === 'redirect from' || heading === 'path');
    const to = headings.findIndex((heading) => heading === 'redirect to' || heading === 'target');
    if (from < 0 || to < 0) {
      return failOne(
        ['csv'],
        'INVALID',
        "The file needs Redirect from and Redirect to columns, as Shopify's redirects export has",
      );
    }

    const errors: RedirectImportRowError[] = [];
    const say = (row: number, column: 0 | 1 | null, message: string) =>
      errors.push({ row, column: column === null ? null : REDIRECT_CSV_HEADINGS[column], message });
    const wanted: { row: number; path: string; target: string }[] = [];
    const rowsByPath = new Map<string, number>();
    records.forEach((cells, index) => {
      const row = index + 2;
      const checked = checkRedirect(
        { path: cells[from] ?? '', target: cells[to] ?? '' },
        { required: true },
      );
      if (!checked.ok) {
        for (const error of checked.errors)
          say(row, error.field[0] === 'path' ? 0 : 1, error.message);
        return;
      }
      const { path, target } = checked.value as { path: string; target: string };
      const earlier = rowsByPath.get(path);
      if (earlier !== undefined) {
        say(row, 0, `The same path as row ${earlier}`);
        return;
      }
      rowsByPath.set(path, row);
      wanted.push({ row, path, target });
    });

    return this.db.tenant(tenant.shopId, async (tx) => {
      const taken = new Set<string>();
      for (let start = 0; start < wanted.length; start += IMPORT_BATCH) {
        const paths = wanted.slice(start, start + IMPORT_BATCH).map((each) => each.path);
        const rows = await tx
          .select({ path: urlRedirects.path })
          .from(urlRedirects)
          .where(and(eq(urlRedirects.shopId, tenant.shopId), inArray(urlRedirects.path, paths)));
        for (const row of rows) taken.add(row.path);
      }
      const fresh = wanted.filter((each) => !taken.has(each.path));
      const [counts] = await tx
        .select({ total: count() })
        .from(urlRedirects)
        .where(eq(urlRedirects.shopId, tenant.shopId));
      const room = Math.max(0, REDIRECT_LIMIT - (counts?.total ?? 0));
      for (const over of fresh.slice(room)) {
        say(
          over.row,
          null,
          `A shop can keep at most ${REDIRECT_LIMIT.toLocaleString('en')} redirects`,
        );
      }
      const made = fresh.slice(0, room);
      let created = made.length;
      if (!dryRun && made.length > 0) {
        created = 0;
        for (let start = 0; start < made.length; start += IMPORT_BATCH) {
          const inserted = await tx
            .insert(urlRedirects)
            .values(
              made.slice(start, start + IMPORT_BATCH).map((each) => ({
                shopId: tenant.shopId,
                id: newId(),
                path: each.path,
                target: each.target,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: urlRedirects.id });
          created += inserted.length;
        }
        await appendEvent<UrlRedirectsImportedPayload>(tx, tenant.shopId, {
          type: OnlineStoreEvents.UrlRedirectsImported,
          aggregateType: 'url_redirect',
          aggregateId: tenant.shopId,
          payload: { created },
        });
      }
      errors.sort((a, b) => a.row - b.row);
      return {
        ok: true,
        value: {
          rows: records.length,
          created,
          skipped: wanted.length - fresh.length,
          rowErrors: errors.slice(0, REDIRECT_IMPORT_LIMITS.rowErrors),
          rowErrorCount: errors.length,
          dryRun,
        },
      };
    });
  }

  /**
   * The shop's redirects as Shopify exports them, Redirect from and Redirect to, by path: a file
   * the import, or Shopify's, takes back.
   */
  async export(tenant: TenantContext): Promise<{ csv: string; count: number }> {
    const rows = await this.db.tenant(tenant.shopId, (tx) => shopRedirectsOf(tx, tenant.shopId));
    return {
      csv: toCsv([[...REDIRECT_CSV_HEADINGS], ...rows.map((row) => [row.path, row.target])]),
      count: rows.length,
    };
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

/** What {@link redirectsMoved} did. */
export interface RedirectsMoved {
  /** Redirects made from old addresses. */
  created: number;
  /** Redirects sent on to new addresses: from an old one, or that sent shoppers to one. */
  updated: number;
  /** Redirects from where the pages are now, gone. */
  deleted: number;
  /** Old addresses left without a redirect: the shop keeps as many as it may. */
  skipped: number;
}

/**
 * {@link redirectMoved} for many pages moved at once, as a blog's articles move with it
 * (ADR-218), in a few statements however many there are: each old address sends shoppers to its
 * new one, in place of a redirect it had, those first in `moves` while the shop has room for
 * more; redirects that sent shoppers to an old address send them to its new one; and those from
 * a new address go. One `url_redirects.moved` event says so, for the storefront. Each page moves
 * once, and none to where another was.
 */
export async function redirectsMoved(
  tx: Tx,
  shopId: string,
  moves: readonly { from: string; to: string }[],
): Promise<RedirectsMoved> {
  const done: RedirectsMoved = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  if (moves.length === 0) return done;
  const froms = moves.map((move) => move.from);
  const tos = moves.map((move) => move.to);
  const arrived = new Set(tos);
  if (new Set(froms).size < froms.length || froms.some((from) => arrived.has(from))) {
    throw new Error('Each page moves once, and none to where another was');
  }
  const pairs = sql`unnest(${sql.param(froms)}::text[], ${sql.param(tos)}::text[])
                    AS m(from_path, to_path)`;

  done.deleted = (
    await tx
      .delete(urlRedirects)
      .where(
        and(
          eq(urlRedirects.shopId, shopId),
          sql`${urlRedirects.path} = ANY(${sql.param(tos)}::text[])`,
        ),
      )
      .returning({ id: urlRedirects.id })
  ).length;
  // Those sending shoppers to an old address, with a query or a fragment or without: by what
  // comes before either, as no path has them.
  const { rows: pointing } = await tx.execute<{ id: string }>(sql`
    UPDATE online_store.url_redirects r
       SET target = m.to_path || substr(r.target, length(m.from_path) + 1), updated_at = now()
      FROM ${pairs}
     WHERE r.shop_id = ${shopId}
       AND split_part(split_part(r.target, '?', 1), '#', 1) = m.from_path
    RETURNING r.id`);
  const { rows: replaced } = await tx.execute<{ id: string }>(sql`
    UPDATE online_store.url_redirects r
       SET target = m.to_path, updated_at = now()
      FROM ${pairs}
     WHERE r.shop_id = ${shopId} AND r.path = m.from_path AND r.target <> m.to_path
    RETURNING r.id`);
  done.updated = new Set([...pointing, ...replaced].map((row) => row.id)).size;

  const [counts] = await tx
    .select({ total: count() })
    .from(urlRedirects)
    .where(eq(urlRedirects.shopId, shopId));
  const room = Math.max(0, REDIRECT_LIMIT - (counts?.total ?? 0));
  const ids = moves.map(() => newId());
  const {
    rows: [made],
  } = await tx.execute<{ wanted: number; created: number }>(sql`
    WITH wanted AS (
      SELECT m.id, m.from_path, m.to_path, m.n
        FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(froms)}::text[],
                    ${sql.param(tos)}::text[]) WITH ORDINALITY AS m(id, from_path, to_path, n)
       WHERE NOT EXISTS (SELECT 1 FROM online_store.url_redirects r
                          WHERE r.shop_id = ${shopId} AND r.path = m.from_path)
    ), made AS (
      INSERT INTO online_store.url_redirects (shop_id, id, path, target)
      SELECT ${shopId}, id, from_path, to_path FROM wanted ORDER BY n LIMIT ${room}
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*) FROM wanted)::int AS wanted, (SELECT count(*) FROM made)::int AS created`);
  done.created = made!.created;
  done.skipped = made!.wanted - made!.created;

  if (done.created + done.updated + done.deleted > 0) {
    await appendEvent<UrlRedirectsMovedPayload>(tx, shopId, {
      type: OnlineStoreEvents.UrlRedirectsMoved,
      aggregateType: 'url_redirect',
      aggregateId: shopId,
      payload: { created: done.created, updated: done.updated, deleted: done.deleted },
    });
  }
  return done;
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

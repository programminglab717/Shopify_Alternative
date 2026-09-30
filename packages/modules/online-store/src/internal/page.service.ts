import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { handleCandidate, toHandle } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { OnlineStoreEvents, type PageChangedPayload, type PageUpdatedPayload } from './events.js';
import { PAGE_HANDLE, PAGE_LIMITS, TEMPLATE_SUFFIX, cleanPageBody } from './page-body.js';
import type { Page, PageRecord } from './records.js';
import { pages, type PageRow } from './schema.js';

/** A page's fields as given: those left out stay as they are on an update. */
export interface PageInput {
  /** Required for a new page. */
  title?: string | null;
  /** From the title when a new page has none: "About us" gives about-us. */
  handle?: string | null;
  /** HTML, cleaned of anything that could run before it is kept. */
  body?: string | null;
  /** A new page is published unless this is false. */
  isPublished?: boolean | null;
  /** Another of the theme's page templates, "contact" for page.contact.json; blank for none. */
  templateSuffix?: string | null;
}

/** Tries at handles from a title before one with a random end: about-us, about-us-2, … */
const HANDLE_ATTEMPTS = 20;

/**
 * A shop's own pages (ADR-045), such as About us, Contact, and how it delivers and takes returns:
 * a title, a handle naming it at /pages/{handle}, and a body of HTML, cleaned when saved of
 * anything that could run. The storefront shows those published, and menus link to them.
 */
@Injectable()
export class PageService {
  constructor(private readonly db: Database) {}

  /** The shop's pages, oldest first. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<Page<PageRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(pages)
        .where(
          and(
            eq(pages.shopId, tenant.shopId),
            options.after ? gt(pages.id, options.after) : undefined,
          ),
        )
        .orderBy(asc(pages.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<PageRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id);
      return row ? toRecord(row) : null;
    });
  }

  async create(tenant: TenantContext, input: PageInput): Promise<MutationResult<PageRecord>> {
    const check = new InputChecker();
    const title = check.text(['title'], input.title, { required: true, max: PAGE_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null ? null : checkHandle(check, input.handle);
    const body = checkBody(check, input.body ?? '');
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok || title === null) return fail(check.errors);
    const published = input.isPublished ?? true;

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [counts] = await tx
        .select({ total: count() })
        .from(pages)
        .where(eq(pages.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= PAGE_LIMITS.pages) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${PAGE_LIMITS.pages} pages`);
      }
      const values = {
        shopId: tenant.shopId,
        id: newId(),
        title,
        body,
        templateSuffix: templateSuffix ?? null,
        publishedAt: published ? sql`now()` : null,
      };
      let row: PageRow | undefined;
      if (handle !== null) {
        [row] = await tx
          .insert(pages)
          .values({ ...values, handle })
          .onConflictDoNothing()
          .returning();
        if (!row) return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another page's`);
      } else {
        // Safe to race: the unique handle decides, and the next candidate is tried.
        const base = toHandle(title) || 'page';
        for (let attempt = 0; attempt < HANDLE_ATTEMPTS && !row; attempt++) {
          [row] = await tx
            .insert(pages)
            .values({ ...values, handle: handleCandidate(base, attempt) })
            .onConflictDoNothing()
            .returning();
        }
        [row] = row
          ? [row]
          : await tx
              .insert(pages)
              .values({ ...values, handle: `${base.slice(0, 80)}-${newId().slice(-6)}` })
              .returning();
      }
      await this.#recordEvent<PageChangedPayload>(tx, OnlineStoreEvents.PageCreated, row!, {
        handle: row!.handle,
        isPublished: row!.publishedAt !== null,
      });
      return { ok: true, value: toRecord(row!) };
    });
  }

  /** Changes the fields given; records `page.updated`, naming them, if any changed. */
  async update(
    tenant: TenantContext,
    id: string,
    input: PageInput,
  ): Promise<MutationResult<PageRecord>> {
    const check = new InputChecker();
    const title =
      input.title === undefined
        ? undefined
        : check.text(['title'], input.title, { required: true, max: PAGE_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null
        ? undefined
        : checkHandle(check, input.handle);
    const body =
      input.body === undefined || input.body === null ? undefined : checkBody(check, input.body);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const page = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!page) return failOne(['id'], 'NOT_FOUND', 'Page not found');
      const published = input.isPublished ?? page.publishedAt !== null;
      const next = {
        title: title ?? page.title,
        handle: handle ?? page.handle,
        body: body ?? page.body,
        templateSuffix: templateSuffix === undefined ? page.templateSuffix : templateSuffix,
      };
      const changed = [
        ...(['title', 'handle', 'body', 'templateSuffix'] as const).filter(
          (field) => next[field] !== page[field],
        ),
        ...(published !== (page.publishedAt !== null) ? ['isPublished'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: toRecord(page) };
      if (next.handle !== page.handle) {
        const [taken] = await tx
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(eq(pages.shopId, tenant.shopId), eq(pages.handle, next.handle), ne(pages.id, id)),
          );
        if (taken) return failOne(['handle'], 'TAKEN', `Handle "${next.handle}" is another page's`);
      }
      const [row] = await tx
        .update(pages)
        .set({
          ...next,
          // Published again, it keeps the time it was first shown since it was last hidden.
          publishedAt: published ? (page.publishedAt ?? sql`now()`) : null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(pages.shopId, tenant.shopId), eq(pages.id, id)))
        .returning();
      await this.#recordEvent<PageUpdatedPayload>(tx, OnlineStoreEvents.PageUpdated, row!, {
        handle: row!.handle,
        isPublished: row!.publishedAt !== null,
        changed,
      });
      return { ok: true, value: toRecord(row!) };
    });
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(pages)
        .where(and(eq(pages.shopId, tenant.shopId), eq(pages.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Page not found');
      await this.#recordEvent<PageChangedPayload>(tx, OnlineStoreEvents.PageDeleted, row, {
        handle: row.handle,
        isPublished: row.publishedAt !== null,
      });
      return { ok: true, value: { id } };
    });
  }

  /**
   * The shop's pages with these IDs, or all of them, in the caller's transaction `tx`: for read
   * models built outside the module, such as the storefront's, and for menus' links.
   */
  async pagesOf(
    tx: Tx,
    shopId: string,
    options: { ids?: readonly string[] } = {},
  ): Promise<PageRecord[]> {
    if (options.ids?.length === 0) return [];
    const rows = await tx
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.shopId, shopId),
          options.ids ? inArray(pages.id, [...new Set(options.ids)]) : undefined,
        ),
      )
      .orderBy(asc(pages.id));
    return rows.map(toRecord);
  }

  /** The IDs of all the shop's pages, in the caller's transaction `tx`. */
  async idsOf(tx: Tx, shopId: string): Promise<string[]> {
    const rows = await tx.select({ id: pages.id }).from(pages).where(eq(pages.shopId, shopId));
    return rows.map((row) => row.id);
  }

  async #recordEvent<P extends PageChangedPayload>(
    tx: Tx,
    type: string,
    row: PageRow,
    payload: P,
  ): Promise<void> {
    await appendEvent<P>(tx, row.shopId, {
      type,
      aggregateType: 'page',
      aggregateId: row.id,
      payload,
    });
  }

  async #find(
    tx: Tx,
    shopId: string,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<PageRow | undefined> {
    const query = tx
      .select()
      .from(pages)
      .where(and(eq(pages.shopId, shopId), eq(pages.id, id)));
    const [row] = options.lock ? await query.for('update') : await query;
    return row;
  }
}

function toRecord(row: PageRow): PageRecord {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    body: row.body,
    isPublished: row.publishedAt !== null,
    publishedAt: row.publishedAt,
    templateSuffix: row.templateSuffix,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A handle as given, made one as the catalog makes them: "About Us" gives about-us. */
function checkHandle(check: InputChecker, value: string): string {
  const handle = toHandle(value);
  if (handle === '' || !PAGE_HANDLE.test(handle)) {
    check.add(['handle'], 'INVALID', 'must contain letters or digits');
  }
  return handle;
}

/** The body, cleaned, within its limit. */
function checkBody(check: InputChecker, value: string): string {
  const body = cleanPageBody(value);
  if (Buffer.byteLength(body) > PAGE_LIMITS.body) {
    check.addMessage(['body'], 'TOO_LONG', 'Body is too long (maximum is 512 KB)');
  }
  return body;
}

/** A template suffix; undefined when not given, null to have none. */
function checkSuffix(
  check: InputChecker,
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const suffix = value?.trim() ?? '';
  if (suffix === '') return null;
  if (!TEMPLATE_SUFFIX.test(suffix)) {
    check.add(
      ['templateSuffix'],
      'INVALID',
      'may have only lower-case letters, digits, hyphens and underscores (at most 50)',
    );
  }
  return suffix;
}

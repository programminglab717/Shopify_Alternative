import {
  InputChecker,
  checkSeo,
  fail,
  failOne,
  type MutationResult,
  type SeoInputValue,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  checkHandle,
  checkHtml,
  checkPublishDate,
  checkSuffix,
  insertWithHandle,
  publicationOf,
  shownBy,
} from './content-input.js';
import { OnlineStoreEvents, type PageChangedPayload, type PageUpdatedPayload } from './events.js';
import { PAGE_LIMITS } from './page-body.js';
import { contentSearchText } from './content-search.js';
import type { Page, PageRecord } from './records.js';
import { pages, type PageRow } from './schema.js';
import { redirectMoved } from './url-redirect.service.js';

/** A page's fields as given: those left out stay as they are on an update. */
export interface PageInput {
  /** Required for a new page. */
  title?: string | null;
  /** From the title when a new page has none: "About us" gives about-us. */
  handle?: string | null;
  /** HTML, cleaned of anything that could run before it is kept. */
  body?: string | null;
  /** A new page is published unless this is false: now, or at its publish date. */
  isPublished?: boolean | null;
  /**
   * When it is shown from: a time gone by, or one ahead it waits for, at most a year, as
   * Shopify's `publishDate` (ADR-217). Now when not given.
   */
  publishDate?: Date | null;
  /** Another of the theme's page templates, "contact" for page.contact.json; blank for none. */
  templateSuffix?: string | null;
  /**
   * What search engines are told in place of its title and body (ADR-231): a field left out
   * stays as it is, and null or blank clears it.
   */
  seo?: SeoInputValue | null;
  /**
   * With a new handle: the page's old address sends shoppers to its new one, as Shopify's
   * `redirectNewHandle` does (ADR-053).
   */
  redirectNewHandle?: boolean | null;
}

/**
 * A shop's own pages (ADR-045), such as About us, Contact, and how it delivers and takes returns:
 * a title, a handle naming it at /pages/{handle}, and a body of HTML, cleaned when saved of
 * anything that could run. The storefront shows those published, once their time comes
 * (ADR-217), and menus link to them.
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
    const body = checkHtml(check, 'body', input.body ?? '', PAGE_LIMITS.body);
    const publishDate = checkPublishDate(check, input.publishDate, PAGE_LIMITS.scheduleDays);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    const seo = checkSeo(check, ['seo'], input.seo);
    if (!check.ok || title === null) return fail(check.errors);
    const publication = publicationOf(null, input.isPublished, publishDate);

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
        seoTitle: seo.title ?? null,
        seoDescription: seo.description ?? null,
        publishedAt: publication.publishedAt === undefined ? sql`now()` : publication.publishedAt,
        // Hidden until its time comes, when the worker shows it (ADR-217).
        scheduled: publication.scheduled,
        searchText: contentSearchText(title, [], body),
      };
      const row = await insertWithHandle(
        async (candidate) =>
          (
            await tx
              .insert(pages)
              .values({ ...values, handle: candidate })
              .onConflictDoNothing()
              .returning()
          )[0],
        handle,
        title,
        'page',
      );
      if (!row) return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another page's`);
      await this.#recordEvent<PageChangedPayload>(tx, OnlineStoreEvents.PageCreated, row, {
        handle: row.handle,
        isPublished: publication.shown,
      });
      return { ok: true, value: toRecord(row) };
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
      input.body === undefined || input.body === null
        ? undefined
        : checkHtml(check, 'body', input.body, PAGE_LIMITS.body);
    const publishDate = checkPublishDate(check, input.publishDate, PAGE_LIMITS.scheduleDays);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    const seo = checkSeo(check, ['seo'], input.seo);
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const page = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!page) return failOne(['id'], 'NOT_FOUND', 'Page not found');
      // Published again, it keeps the time it was first shown since it was last hidden, unless
      // another is given; one waiting for its time keeps it (ADR-217).
      const publication = publicationOf(page, input.isPublished, publishDate);
      const next = {
        title: title ?? page.title,
        handle: handle ?? page.handle,
        body: body ?? page.body,
        templateSuffix: templateSuffix === undefined ? page.templateSuffix : templateSuffix,
        seoTitle: seo.title === undefined ? page.seoTitle : seo.title,
        seoDescription: seo.description === undefined ? page.seoDescription : seo.description,
      };
      const changed = [
        ...(
          ['title', 'handle', 'body', 'templateSuffix', 'seoTitle', 'seoDescription'] as const
        ).filter((field) => next[field] !== page[field]),
        ...publication.changed,
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
          searchText: contentSearchText(next.title, [], next.body),
          publishedAt: publication.publishedAt === undefined ? sql`now()` : publication.publishedAt,
          scheduled: publication.scheduled,
          updatedAt: sql`now()`,
        })
        .where(and(eq(pages.shopId, tenant.shopId), eq(pages.id, id)))
        .returning();
      await this.#recordEvent<PageUpdatedPayload>(tx, OnlineStoreEvents.PageUpdated, row!, {
        handle: row!.handle,
        isPublished: publication.shown,
        changed,
      });
      if (input.redirectNewHandle && row!.handle !== page.handle) {
        // With the page, or not at all. A shop with all the redirects it may keep gets none more.
        await redirectMoved(tx, tenant.shopId, `/pages/${page.handle}`, `/pages/${row!.handle}`);
      }
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
        isPublished: shownBy(row.publishedAt),
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

  /**
   * The shops with pages whose time came (ADR-217), found with the system role, which sees every
   * shop.
   */
  async shopsWithPagesDue(): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM online_store.pages
         WHERE scheduled AND published_at <= now()`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Shows the shop's pages whose time came (ADR-217): each recorded as shown with its
   * `page.updated`, saying it is published now, once. How many.
   */
  async showDue(shopId: string): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const rows = await tx
        .update(pages)
        .set({ scheduled: false })
        .where(
          and(
            eq(pages.shopId, shopId),
            eq(pages.scheduled, true),
            lte(pages.publishedAt, sql`now()`),
          ),
        )
        .returning();
      for (const row of rows) {
        await this.#recordEvent<PageUpdatedPayload>(tx, OnlineStoreEvents.PageUpdated, row, {
          handle: row.handle,
          isPublished: true,
          changed: ['isPublished'],
        });
      }
      return rows.length;
    });
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
    isPublished: shownBy(row.publishedAt),
    publishedAt: row.publishedAt,
    templateSuffix: row.templateSuffix,
    seo: { title: row.seoTitle, description: row.seoDescription },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { checkHandle, checkSuffix, insertWithHandle } from './content-input.js';
import { OnlineStoreEvents, type BlogChangedPayload, type BlogUpdatedPayload } from './events.js';
import type { BlogRecord, Page } from './records.js';
import { articles, blogs, type BlogRow } from './schema.js';
import { redirectMoved } from './url-redirect.service.js';

/** What a shop's blogs and articles may hold (ADR-176). */
export const BLOG_LIMITS = {
  blogs: 50,
  /** Articles in all of a shop's blogs. */
  articles: 10_000,
  title: 255,
  /** An article's body as HTML, cleaned, in bytes, as a page's. */
  body: 512 * 1024,
  /** An article's summary as HTML, cleaned, in bytes. */
  summary: 64 * 1024,
  author: 255,
  /** What an article's image shows, as a file's alt text (ADR-213). */
  imageAlt: 512,
  /** How far ahead an article may be published (ADR-215), in days. */
  scheduleDays: 366,
} as const;

/** A blog's fields as given: those left out stay as they are on an update. */
export interface BlogInput {
  /** Required for a new blog. */
  title?: string | null;
  /** From the title when a new blog has none: "News" gives news. */
  handle?: string | null;
  /** Another of the theme's blog templates, "news" for blog.news.json; blank for none. */
  templateSuffix?: string | null;
  /**
   * With a new handle: the blog's old address sends shoppers to its new one, as Shopify's
   * `redirectNewHandle` does (ADR-053).
   */
  redirectNewHandle?: boolean | null;
}

/**
 * A shop's blogs (OS-07, ADR-176), such as News: a title and a handle naming it at
 * /blogs/{handle}, where the storefront lists its published articles, the latest first. Deleting
 * one deletes its articles.
 */
@Injectable()
export class BlogService {
  constructor(private readonly db: Database) {}

  /** The shop's blogs, oldest first. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<Page<BlogRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(blogs)
        .where(
          and(
            eq(blogs.shopId, tenant.shopId),
            options.after ? gt(blogs.id, options.after) : undefined,
          ),
        )
        .orderBy(asc(blogs.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<BlogRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await this.blogsOf(tx, tenant.shopId, { ids: [id] });
      return row ?? null;
    });
  }

  /** The shop's blogs with these IDs, by ID. */
  async byIds(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, BlogRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await this.blogsOf(tx, tenant.shopId, { ids });
      return new Map(found.map((blog) => [blog.id, blog]));
    });
  }

  /** How many articles each of these blogs has, published or not; those with none left out. */
  async articleCounts(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ blogId: articles.blogId, total: count() })
        .from(articles)
        .where(and(eq(articles.shopId, tenant.shopId), inArray(articles.blogId, [...ids])))
        .groupBy(articles.blogId);
      return new Map(rows.map((row) => [row.blogId, row.total]));
    });
  }

  async create(tenant: TenantContext, input: BlogInput): Promise<MutationResult<BlogRecord>> {
    const check = new InputChecker();
    const title = check.text(['title'], input.title, { required: true, max: BLOG_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null ? null : checkHandle(check, input.handle);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok || title === null) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [counts] = await tx
        .select({ total: count() })
        .from(blogs)
        .where(eq(blogs.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= BLOG_LIMITS.blogs) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${BLOG_LIMITS.blogs} blogs`);
      }
      const values = {
        shopId: tenant.shopId,
        id: newId(),
        title,
        templateSuffix: templateSuffix ?? null,
      };
      const row = await insertWithHandle(
        async (candidate) =>
          (
            await tx
              .insert(blogs)
              .values({ ...values, handle: candidate })
              .onConflictDoNothing()
              .returning()
          )[0],
        handle,
        title,
        'blog',
      );
      if (!row) return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another blog's`);
      await this.#recordEvent<BlogChangedPayload>(tx, OnlineStoreEvents.BlogCreated, row, {
        handle: row.handle,
      });
      return { ok: true, value: toRecord(row) };
    });
  }

  /** Changes the fields given; records `blog.updated`, naming them, if any changed. */
  async update(
    tenant: TenantContext,
    id: string,
    input: BlogInput,
  ): Promise<MutationResult<BlogRecord>> {
    const check = new InputChecker();
    const title =
      input.title === undefined
        ? undefined
        : check.text(['title'], input.title, { required: true, max: BLOG_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null
        ? undefined
        : checkHandle(check, input.handle);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [blog] = await tx
        .select()
        .from(blogs)
        .where(and(eq(blogs.shopId, tenant.shopId), eq(blogs.id, id)))
        .for('update');
      if (!blog) return failOne(['id'], 'NOT_FOUND', 'Blog not found');
      const next = {
        title: title ?? blog.title,
        handle: handle ?? blog.handle,
        templateSuffix: templateSuffix === undefined ? blog.templateSuffix : templateSuffix,
      };
      const changed = (['title', 'handle', 'templateSuffix'] as const).filter(
        (field) => next[field] !== blog[field],
      );
      if (changed.length === 0) return { ok: true, value: toRecord(blog) };
      if (next.handle !== blog.handle) {
        const [taken] = await tx
          .select({ id: blogs.id })
          .from(blogs)
          .where(
            and(eq(blogs.shopId, tenant.shopId), eq(blogs.handle, next.handle), ne(blogs.id, id)),
          );
        if (taken) return failOne(['handle'], 'TAKEN', `Handle "${next.handle}" is another blog's`);
      }
      const [row] = await tx
        .update(blogs)
        .set({ ...next, updatedAt: sql`now()` })
        .where(and(eq(blogs.shopId, tenant.shopId), eq(blogs.id, id)))
        .returning();
      await this.#recordEvent<BlogUpdatedPayload>(tx, OnlineStoreEvents.BlogUpdated, row!, {
        handle: row!.handle,
        changed,
      });
      if (input.redirectNewHandle && row!.handle !== blog.handle) {
        // The blog's own address; its articles' are their own redirects to make.
        await redirectMoved(tx, tenant.shopId, `/blogs/${blog.handle}`, `/blogs/${row!.handle}`);
      }
      return { ok: true, value: toRecord(row!) };
    });
  }

  /** Deletes a blog and its articles. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(blogs)
        .where(and(eq(blogs.shopId, tenant.shopId), eq(blogs.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Blog not found');
      await this.#recordEvent<BlogChangedPayload>(tx, OnlineStoreEvents.BlogDeleted, row, {
        handle: row.handle,
      });
      return { ok: true, value: { id } };
    });
  }

  /**
   * The shop's blogs with these IDs, or all of them, oldest first, in the caller's transaction
   * `tx`: for read models built outside the module, such as the storefront's, and menus' links.
   */
  async blogsOf(
    tx: Tx,
    shopId: string,
    options: { ids?: readonly string[] } = {},
  ): Promise<BlogRecord[]> {
    if (options.ids?.length === 0) return [];
    const rows = await tx
      .select()
      .from(blogs)
      .where(
        and(
          eq(blogs.shopId, shopId),
          options.ids ? inArray(blogs.id, [...new Set(options.ids)]) : undefined,
        ),
      )
      .orderBy(asc(blogs.id));
    return rows.map(toRecord);
  }

  async #recordEvent<P extends BlogChangedPayload>(
    tx: Tx,
    type: string,
    row: BlogRow,
    payload: P,
  ): Promise<void> {
    await appendEvent<P>(tx, row.shopId, {
      type,
      aggregateType: 'blog',
      aggregateId: row.id,
      payload,
    });
  }
}

function toRecord(row: BlogRow): BlogRecord {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    templateSuffix: row.templateSuffix,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

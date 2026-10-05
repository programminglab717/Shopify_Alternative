import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { BLOG_LIMITS } from './blog.service.js';
import { checkHandle, checkHtml, checkSuffix, insertWithHandle } from './content-input.js';
import {
  OnlineStoreEvents,
  type ArticleChangedPayload,
  type ArticleUpdatedPayload,
} from './events.js';
import type { ArticleRecord, Page } from './records.js';
import { articles, blogs, type ArticleRow } from './schema.js';
import { redirectMoved } from './url-redirect.service.js';

/** An article's fields as given: those left out stay as they are on an update. */
export interface ArticleInput {
  /** The blog it is in: required for a new article; another moves it there. */
  blogId?: string | null;
  /** Required for a new article. */
  title?: string | null;
  /** From the title when a new article has none, unique in its blog. */
  handle?: string | null;
  /** HTML, cleaned of anything that could run before it is kept. */
  body?: string | null;
  /** HTML the blog's page shows of it, cleaned as the body is; blank for none. */
  summary?: string | null;
  /** The name it is signed with; blank for none. */
  author?: string | null;
  tags?: string[] | null;
  /** A new article is published unless this is false. */
  isPublished?: boolean | null;
  /**
   * When it was published, as its page says, for one written before, such as one brought from
   * another platform: never in the future. Now when not given.
   */
  publishDate?: Date | null;
  /** Another of the theme's article templates, "recipe" for article.recipe.json; blank for none. */
  templateSuffix?: string | null;
  /**
   * With a new handle or blog: the article's old address sends shoppers to its new one, as
   * Shopify's `redirectNewHandle` does (ADR-053).
   */
  redirectNewHandle?: boolean | null;
}

/** How far ahead of the server's clock a publish date may be, for clients' clocks running fast. */
const CLOCK_SKEW_MS = 60_000;

/**
 * The articles of a shop's blogs (OS-07, ADR-176): a title, a handle naming it at
 * /blogs/{blog}/{handle}, a body and a summary of HTML, cleaned when saved as pages' are, its
 * author's name, tags, and when it was published. The storefront shows those published.
 */
@Injectable()
export class ArticleService {
  constructor(private readonly db: Database) {}

  /** The shop's articles, or one blog's, oldest first. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; blogId?: string | null },
  ): Promise<Page<ArticleRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(articles)
        .where(
          and(
            eq(articles.shopId, tenant.shopId),
            options.blogId ? eq(articles.blogId, options.blogId) : undefined,
            options.after ? gt(articles.id, options.after) : undefined,
          ),
        )
        .orderBy(asc(articles.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<ArticleRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await this.articlesOf(tx, tenant.shopId, { ids: [id] });
      return row ?? null;
    });
  }

  async create(tenant: TenantContext, input: ArticleInput): Promise<MutationResult<ArticleRecord>> {
    const check = new InputChecker();
    if (!input.blogId) check.add(['blogId'], 'BLANK', "can't be blank");
    const title = check.text(['title'], input.title, { required: true, max: BLOG_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null ? null : checkHandle(check, input.handle);
    const body = checkHtml(check, 'body', input.body ?? '', BLOG_LIMITS.body);
    const summary = checkHtml(check, 'summary', input.summary ?? '', BLOG_LIMITS.summary);
    const author = check.text(['author'], input.author, { max: BLOG_LIMITS.author }) ?? '';
    const tags = check.tags(['tags'], input.tags);
    const publishDate = checkPublishDate(check, input.publishDate);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok || title === null || !input.blogId) return fail(check.errors);
    const blogId = input.blogId;
    const published = input.isPublished ?? true;

    return this.db.tenant(tenant.shopId, async (tx) => {
      // Kept from being deleted until the article is in it.
      const [blog] = await tx
        .select({ id: blogs.id })
        .from(blogs)
        .where(and(eq(blogs.shopId, tenant.shopId), eq(blogs.id, blogId)))
        .for('share');
      if (!blog) return failOne(['blogId'], 'NOT_FOUND', 'Blog not found');
      const [counts] = await tx
        .select({ total: count() })
        .from(articles)
        .where(eq(articles.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= BLOG_LIMITS.articles) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${BLOG_LIMITS.articles} articles`);
      }
      const values = {
        shopId: tenant.shopId,
        id: newId(),
        blogId,
        title,
        body,
        summary,
        author,
        tags,
        templateSuffix: templateSuffix ?? null,
        publishedAt: published ? (publishDate ?? sql`now()`) : null,
      };
      const row = await insertWithHandle(
        async (candidate) =>
          (
            await tx
              .insert(articles)
              .values({ ...values, handle: candidate })
              .onConflictDoNothing()
              .returning()
          )[0],
        handle,
        title,
        'article',
      );
      if (!row) {
        return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another article's in its blog`);
      }
      await this.#recordEvent<ArticleChangedPayload>(tx, OnlineStoreEvents.ArticleCreated, row, {
        blogId: row.blogId,
        handle: row.handle,
        isPublished: row.publishedAt !== null,
      });
      return { ok: true, value: toRecord(row) };
    });
  }

  /** Changes the fields given; records `article.updated`, naming them, if any changed. */
  async update(
    tenant: TenantContext,
    id: string,
    input: ArticleInput,
  ): Promise<MutationResult<ArticleRecord>> {
    const check = new InputChecker();
    const title =
      input.title === undefined
        ? undefined
        : check.text(['title'], input.title, { required: true, max: BLOG_LIMITS.title });
    const handle =
      input.handle === undefined || input.handle === null
        ? undefined
        : checkHandle(check, input.handle);
    const body =
      input.body === undefined || input.body === null
        ? undefined
        : checkHtml(check, 'body', input.body, BLOG_LIMITS.body);
    const summary =
      input.summary === undefined
        ? undefined
        : checkHtml(check, 'summary', input.summary ?? '', BLOG_LIMITS.summary);
    const author =
      input.author === undefined
        ? undefined
        : (check.text(['author'], input.author, { max: BLOG_LIMITS.author }) ?? '');
    const tags = input.tags === undefined ? undefined : check.tags(['tags'], input.tags);
    const publishDate = checkPublishDate(check, input.publishDate);
    const templateSuffix = checkSuffix(check, input.templateSuffix);
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [article] = await tx
        .select()
        .from(articles)
        .where(and(eq(articles.shopId, tenant.shopId), eq(articles.id, id)))
        .for('update');
      if (!article) return failOne(['id'], 'NOT_FOUND', 'Article not found');
      const blogId = input.blogId ?? article.blogId;
      if (blogId !== article.blogId) {
        const [blog] = await tx
          .select({ id: blogs.id })
          .from(blogs)
          .where(and(eq(blogs.shopId, tenant.shopId), eq(blogs.id, blogId)))
          .for('share');
        if (!blog) return failOne(['blogId'], 'NOT_FOUND', 'Blog not found');
      }
      const published = input.isPublished ?? article.publishedAt !== null;
      const next = {
        blogId,
        title: title ?? article.title,
        handle: handle ?? article.handle,
        body: body ?? article.body,
        summary: summary ?? article.summary,
        author: author ?? article.author,
        templateSuffix: templateSuffix === undefined ? article.templateSuffix : templateSuffix,
      };
      const nextTags = tags ?? article.tags;
      // Published again, it keeps the time it was first shown since it was last hidden, unless
      // another is given.
      const publishedAt = published ? (publishDate ?? article.publishedAt) : null;
      const changed = [
        ...(['title', 'handle', 'body', 'summary', 'author', 'templateSuffix'] as const).filter(
          (field) => next[field] !== article[field],
        ),
        ...(nextTags.join('\n') !== article.tags.join('\n') ? ['tags'] : []),
        ...(published !== (article.publishedAt !== null) ? ['isPublished'] : []),
        ...(published &&
        article.publishedAt !== null &&
        publishedAt?.getTime() !== article.publishedAt.getTime()
          ? ['publishedAt']
          : []),
        ...(blogId !== article.blogId ? ['blogId'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: toRecord(article) };
      if (next.handle !== article.handle || blogId !== article.blogId) {
        const [taken] = await tx
          .select({ id: articles.id })
          .from(articles)
          .where(
            and(
              eq(articles.shopId, tenant.shopId),
              eq(articles.blogId, blogId),
              eq(articles.handle, next.handle),
              ne(articles.id, id),
            ),
          );
        if (taken) {
          return failOne(
            ['handle'],
            'TAKEN',
            `Handle "${next.handle}" is another article's in its blog`,
          );
        }
      }
      const [row] = await tx
        .update(articles)
        .set({
          ...next,
          tags: nextTags,
          publishedAt: published ? (publishedAt ?? sql`now()`) : null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(articles.shopId, tenant.shopId), eq(articles.id, id)))
        .returning();
      await this.#recordEvent<ArticleUpdatedPayload>(tx, OnlineStoreEvents.ArticleUpdated, row!, {
        blogId: row!.blogId,
        handle: row!.handle,
        isPublished: row!.publishedAt !== null,
        changed,
        previousBlogId: blogId !== article.blogId ? article.blogId : null,
      });
      if (input.redirectNewHandle && (changed.includes('handle') || changed.includes('blogId'))) {
        // With the article, or not at all. A shop with all the redirects it may keep gets none more.
        const handles = new Map(
          (
            await tx
              .select({ id: blogs.id, handle: blogs.handle })
              .from(blogs)
              .where(
                and(eq(blogs.shopId, tenant.shopId), inArray(blogs.id, [article.blogId, blogId])),
              )
          ).map((blog) => [blog.id, blog.handle]),
        );
        await redirectMoved(
          tx,
          tenant.shopId,
          `/blogs/${handles.get(article.blogId)}/${article.handle}`,
          `/blogs/${handles.get(blogId)}/${row!.handle}`,
        );
      }
      return { ok: true, value: toRecord(row!) };
    });
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(articles)
        .where(and(eq(articles.shopId, tenant.shopId), eq(articles.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Article not found');
      await this.#recordEvent<ArticleChangedPayload>(tx, OnlineStoreEvents.ArticleDeleted, row, {
        blogId: row.blogId,
        handle: row.handle,
        isPublished: row.publishedAt !== null,
      });
      return { ok: true, value: { id } };
    });
  }

  /**
   * The shop's articles with these IDs, or in these blogs, or all of them, in the caller's
   * transaction `tx`, the latest published first and those not published last: for read models
   * built outside the module, such as the storefront's, and for menus' links.
   */
  async articlesOf(
    tx: Tx,
    shopId: string,
    options: { ids?: readonly string[]; blogIds?: readonly string[]; published?: boolean } = {},
  ): Promise<ArticleRecord[]> {
    if (options.ids?.length === 0 || options.blogIds?.length === 0) return [];
    const rows = await tx
      .select()
      .from(articles)
      .where(
        and(
          eq(articles.shopId, shopId),
          options.ids ? inArray(articles.id, [...new Set(options.ids)]) : undefined,
          options.blogIds ? inArray(articles.blogId, [...new Set(options.blogIds)]) : undefined,
          options.published ? isNotNull(articles.publishedAt) : undefined,
        ),
      )
      .orderBy(sql`${articles.publishedAt} DESC NULLS LAST`, desc(articles.id));
    return rows.map(toRecord);
  }

  /** The IDs of the shop's articles, or of these blogs', in the caller's transaction `tx`. */
  async idsOf(
    tx: Tx,
    shopId: string,
    options: { blogIds?: readonly string[] } = {},
  ): Promise<string[]> {
    if (options.blogIds?.length === 0) return [];
    const rows = await tx
      .select({ id: articles.id })
      .from(articles)
      .where(
        and(
          eq(articles.shopId, shopId),
          options.blogIds ? inArray(articles.blogId, [...new Set(options.blogIds)]) : undefined,
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * The published articles of these blogs, the latest first, with their tags alone: what a blog's
   * page lists, in the caller's transaction `tx`, without their bodies.
   */
  async publishedIn(
    tx: Tx,
    shopId: string,
    blogIds: readonly string[],
  ): Promise<{ id: string; blogId: string; tags: string[] }[]> {
    if (blogIds.length === 0) return [];
    return tx
      .select({ id: articles.id, blogId: articles.blogId, tags: articles.tags })
      .from(articles)
      .where(
        and(
          eq(articles.shopId, shopId),
          inArray(articles.blogId, [...new Set(blogIds)]),
          isNotNull(articles.publishedAt),
        ),
      )
      .orderBy(desc(articles.publishedAt), desc(articles.id));
  }

  async #recordEvent<P extends ArticleChangedPayload>(
    tx: Tx,
    type: string,
    row: ArticleRow,
    payload: P,
  ): Promise<void> {
    await appendEvent<P>(tx, row.shopId, {
      type,
      aggregateType: 'article',
      aggregateId: row.id,
      payload,
    });
  }
}

function toRecord(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    blogId: row.blogId,
    handle: row.handle,
    title: row.title,
    body: row.body,
    summary: row.summary,
    author: row.author,
    tags: row.tags,
    isPublished: row.publishedAt !== null,
    publishedAt: row.publishedAt,
    templateSuffix: row.templateSuffix,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A publish date as given, never in the future; undefined when not given. */
function checkPublishDate(check: InputChecker, value: Date | null | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (Number.isNaN(value.getTime()) || value.getTime() > Date.now() + CLOCK_SKEW_MS) {
    check.add(['publishDate'], 'INVALID', "can't be in the future");
  }
  return value;
}

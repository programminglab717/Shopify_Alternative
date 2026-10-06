import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { OnlineStoreEvents, type CommentChangedPayload } from './events.js';
import type { CommentRecord, Page } from './records.js';
import { articles, blogs, comments, type CommentRow, type CommentStatusValue } from './schema.js';

/** What a comment may hold, and how many of an article's its storefront shows (ADR-220). */
export const COMMENT_LIMITS = {
  author: 255,
  email: 254,
  /** Characters of plain text. */
  body: 5_000,
  userAgent: 512,
  /** The latest published comments an article's document carries, shown the oldest first. */
  shown: 100,
} as const;

/** A shopper's comment as the storefront's form posts it, on the article its address names. */
export interface CommentPost {
  /** The blog's handle and the article's, as in the article's address: news, eid-edit. */
  blog: string;
  article: string;
  author: string;
  email: string;
  body: string;
  /** Where it came from, as the storefront saw the shopper. */
  ip?: string | null;
  userAgent?: string | null;
}

/** An article's comments as its storefront shows them: the latest published, and how many. */
export interface ShownComments {
  /** The latest {@link COMMENT_LIMITS.shown} published, the oldest of them first. */
  comments: CommentRecord[];
  /** Every published comment of the article's. */
  count: number;
}

/**
 * Comments shoppers post on a shop's articles (OS-07, ADR-220), as Shopify's: taken only where
 * the article's blog takes them, held for the shop's approval where it moderates them, and shown
 * at once where it publishes them automatically. The shop approves them, marks them as spam or
 * not, and deletes them.
 */
@Injectable()
export class CommentService {
  constructor(private readonly db: Database) {}

  /**
   * A shopper's comment from an article's page on the shop's storefront: published, or pending
   * where the blog moderates comments; refused where the blog takes none, the article is not
   * shown, or a field is wrong, the errors naming `author`, `email` or `body`.
   */
  async post(
    shopId: string,
    input: CommentPost,
  ): Promise<MutationResult<{ id: string; status: CommentStatusValue }>> {
    const check = new InputChecker();
    const author = check.text(['author'], input.author, {
      required: true,
      max: COMMENT_LIMITS.author,
    });
    const email = check.email(['email'], input.email);
    if (email === null && !check.errors.some((error) => error.field[0] === 'email')) {
      check.add(['email'], 'BLANK', "can't be blank");
    }
    const body = check.text(['body'], plainText(input.body), {
      required: true,
      max: COMMENT_LIMITS.body,
    });
    if (!check.ok || author === null || email === null || body === null) return fail(check.errors);

    return this.db.tenant(shopId, async (tx) => {
      const [found] = await tx
        .select({ id: articles.id, policy: blogs.commentPolicy })
        .from(articles)
        .innerJoin(blogs, and(eq(blogs.shopId, articles.shopId), eq(blogs.id, articles.blogId)))
        .where(
          and(
            eq(articles.shopId, shopId),
            eq(blogs.handle, input.blog),
            eq(articles.handle, input.article),
            // Shown, as the storefront shows articles (ADR-215).
            lte(articles.publishedAt, sql`now()`),
          ),
        );
      if (!found) return failOne(['article'], 'NOT_FOUND', 'Article not found');
      if (found.policy === 'closed') {
        return failOne(['article'], 'INVALID', "This article doesn't take comments");
      }
      const status: CommentStatusValue = found.policy === 'moderated' ? 'pending' : 'published';
      const [row] = await tx
        .insert(comments)
        .values({
          shopId,
          id: newId(),
          articleId: found.id,
          author,
          email,
          body,
          status,
          ip: input.ip && isIP(input.ip) ? input.ip : null,
          userAgent: input.userAgent?.slice(0, COMMENT_LIMITS.userAgent) || null,
          publishedAt: status === 'published' ? sql`now()` : null,
        })
        .returning();
      await this.#recordEvent(tx, OnlineStoreEvents.CommentCreated, row!, status === 'published');
      return { ok: true, value: { id: row!.id, status } };
    });
  }

  /** The shop's comments, the latest first; with `status` or `articleId`, those alone. */
  async list(
    tenant: TenantContext,
    options: {
      first: number;
      after?: string | null;
      status?: CommentStatusValue | null;
      articleId?: string | null;
    },
  ): Promise<Page<CommentRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.shopId, tenant.shopId),
            options.after ? lt(comments.id, options.after) : undefined,
            options.status ? eq(comments.status, options.status) : undefined,
            options.articleId ? eq(comments.articleId, options.articleId) : undefined,
          ),
        )
        .orderBy(desc(comments.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<CommentRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .select()
        .from(comments)
        .where(and(eq(comments.shopId, tenant.shopId), eq(comments.id, id)));
      return row ? toRecord(row) : null;
    });
  }

  /** How many comments each of these articles has, whatever their status; none left out. */
  async countsOf(
    tenant: TenantContext,
    articleIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (articleIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ articleId: comments.articleId, total: count() })
        .from(comments)
        .where(
          and(eq(comments.shopId, tenant.shopId), inArray(comments.articleId, [...articleIds])),
        )
        .groupBy(comments.articleId);
      return new Map(rows.map((row) => [row.articleId, row.total]));
    });
  }

  /** Shows the comment on the storefront, as the shop approves it. */
  async approve(tenant: TenantContext, id: string): Promise<MutationResult<CommentRecord>> {
    return this.#setStatus(tenant, id, 'published');
  }

  /** Takes the comment off the storefront as spam, where it stays for the shop to look at. */
  async markSpam(tenant: TenantContext, id: string): Promise<MutationResult<CommentRecord>> {
    return this.#setStatus(tenant, id, 'spam');
  }

  /** A comment taken for spam that is not: shown, as one approved. */
  async markNotSpam(tenant: TenantContext, id: string): Promise<MutationResult<CommentRecord>> {
    return this.#setStatus(tenant, id, 'published');
  }

  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [row] = await tx
        .delete(comments)
        .where(and(eq(comments.shopId, tenant.shopId), eq(comments.id, id)))
        .returning();
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Comment not found');
      await this.#recordEvent(
        tx,
        OnlineStoreEvents.CommentDeleted,
        row,
        row.status === 'published',
      );
      return { ok: true, value: { id } };
    });
  }

  /**
   * These articles' comments as their storefront shows them, in the caller's transaction `tx`,
   * for read models built outside the module: each article's latest published, the oldest of
   * them first, and how many it has published; articles with none left out.
   */
  async shownCommentsOf(
    tx: Tx,
    shopId: string,
    articleIds: readonly string[],
  ): Promise<Map<string, ShownComments>> {
    if (articleIds.length === 0) return new Map();
    const { rows } = await tx.execute<CommentSqlRow & { total: number }>(sql`
      SELECT * FROM (
        SELECT c.*, count(*) OVER (PARTITION BY c.article_id)::int AS total,
               row_number() OVER (PARTITION BY c.article_id ORDER BY c.id DESC) AS latest
          FROM online_store.comments c
         WHERE c.shop_id = ${shopId} AND c.status = 'published'
           AND c.article_id = ANY(${sql.param([...new Set(articleIds)])}::uuid[])
      ) ranked
       WHERE latest <= ${COMMENT_LIMITS.shown}
       ORDER BY article_id, id`);
    const shown = new Map<string, ShownComments>();
    for (const row of rows) {
      const entry = shown.get(row.article_id) ?? { comments: [], count: row.total };
      entry.comments.push(fromSqlRow(row));
      shown.set(row.article_id, entry);
    }
    return shown;
  }

  async #setStatus(
    tenant: TenantContext,
    id: string,
    status: CommentStatusValue,
  ): Promise<MutationResult<CommentRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [comment] = await tx
        .select()
        .from(comments)
        .where(and(eq(comments.shopId, tenant.shopId), eq(comments.id, id)))
        .for('update');
      if (!comment) return failOne(['id'], 'NOT_FOUND', 'Comment not found');
      if (comment.status === status) return { ok: true, value: toRecord(comment) };
      const [row] = await tx
        .update(comments)
        .set({
          status,
          // When it was first shown, kept through spam and back.
          publishedAt:
            status === 'published' && !comment.publishedAt ? sql`now()` : comment.publishedAt,
          updatedAt: sql`now()`,
        })
        .where(and(eq(comments.shopId, tenant.shopId), eq(comments.id, id)))
        .returning();
      await this.#recordEvent(
        tx,
        OnlineStoreEvents.CommentUpdated,
        row!,
        comment.status === 'published' || status === 'published',
      );
      return { ok: true, value: toRecord(row!) };
    });
  }

  async #recordEvent(tx: Tx, type: string, row: CommentRow, shown: boolean): Promise<void> {
    await appendEvent<CommentChangedPayload>(tx, row.shopId, {
      type,
      aggregateType: 'comment',
      aggregateId: row.id,
      payload: { articleId: row.articleId, status: row.status, shown },
    });
  }
}

/**
 * A comment's plain text as HTML, as Shopify's `bodyHtml` and the storefront show it: escaped,
 * its paragraphs apart and its lines broken where they were (ADR-220).
 */
export function commentHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * A comment's body as kept: plain text, its lines ending in newlines, without control
 * characters, which Postgres refuses or a page cannot show.
 */
function plainText(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cc}/gu, (char) => (char === '\n' || char === '\t' ? char : ''));
}

/** A comment's row as a query of SQL returns it. */
type CommentSqlRow = {
  id: string;
  article_id: string;
  author: string;
  email: string;
  body: string;
  status: CommentStatusValue;
  ip: string | null;
  user_agent: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function fromSqlRow(row: CommentSqlRow): CommentRecord {
  return {
    id: row.id,
    articleId: row.article_id,
    author: row.author,
    email: row.email,
    body: row.body,
    status: row.status,
    ip: row.ip,
    userAgent: row.user_agent,
    publishedAt: toDateOrNull(row.published_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toRecord(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    articleId: row.articleId,
    author: row.author,
    email: row.email,
    body: row.body,
    status: row.status,
    ip: row.ip,
    userAgent: row.userAgent,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

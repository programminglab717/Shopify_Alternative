import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  REVIEW_LIMITS,
  ReviewEvents,
  reviewSettingsIn,
  type ProductReviewChangedPayload,
  type ReviewSettingsRecord,
  type ReviewStatusValue,
} from './reviews.js';

/** A review as the Admin API shows it. */
export interface ProductReviewRecord {
  id: string;
  productId: string;
  productTitle: string;
  orderId: string;
  authorName: string;
  rating: number;
  body: string | null;
  status: ReviewStatusValue;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export interface ReviewQuery {
  first?: number;
  /** A review's ID: those older than it. */
  after?: string | null;
  status?: ReviewStatusValue | null;
  productId?: string | null;
}

type ReviewRow = {
  id: string;
  product_id: string;
  product_title: string;
  order_id: string;
  author_name: string;
  rating: number;
  body: string | null;
  status: ReviewStatusValue;
  created_at: string | Date;
  updated_at: string | Date;
  published_at: string | Date | null;
};

function toRecord(row: ReviewRow): ProductReviewRecord {
  return {
    id: row.id,
    productId: row.product_id,
    productTitle: row.product_title,
    orderId: row.order_id,
    authorName: row.author_name,
    rating: row.rating,
    body: row.body,
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    publishedAt: row.published_at === null ? null : toDate(row.published_at),
  };
}

const COLUMNS = sql.raw(
  'r.id, r.product_id, p.title AS product_title, r.order_id, r.author_name, r.rating, r.body, ' +
    'r.status, r.created_at, r.updated_at, r.published_at',
);

/** The stars a shop may publish reviews from by itself. */
export const PUBLISH_FROM = [3, 4, 5] as const;

/**
 * The shop's products' reviews (MKT-05, ADR-399), as its staff and apps moderate them: the
 * latest first, those waiting, published or hidden, or one product's; each published or hidden;
 * from how many stars reviews publish by themselves, and when the shop asks for them (ADR-400).
 * Customers write them on their delivered orders' pages ({@link writeReviewsIn}).
 */
@Injectable()
export class ProductReviewService {
  constructor(private readonly db: Database) {}

  async list(tenant: TenantContext, query: ReviewQuery = {}): Promise<ProductReviewRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<ReviewRow>(sql`
        SELECT ${COLUMNS}
          FROM catalog.product_reviews r
          JOIN catalog.products p ON p.shop_id = r.shop_id AND p.id = r.product_id
         WHERE r.shop_id = ${tenant.shopId}
           ${query.status ? sql`AND r.status = ${query.status}` : sql``}
           ${query.productId ? sql`AND r.product_id = ${query.productId}` : sql``}
           ${
             query.after
               ? sql`AND (r.created_at, r.id) < (
                   SELECT created_at, id FROM catalog.product_reviews
                    WHERE shop_id = ${tenant.shopId} AND id = ${query.after})`
               : sql``
           }
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${Math.min(Math.max(query.first ?? REVIEW_LIMITS.page, 1), 250)}`),
    );
    return rows.map(toRecord);
  }

  /** Publishes a review, or hides it from the storefront. */
  async moderate(
    tenant: TenantContext,
    id: string,
    to: 'published' | 'hidden',
  ): Promise<MutationResult<ProductReviewRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string; product_id: string; rating: number }>(sql`
        UPDATE catalog.product_reviews
           SET status = ${to},
               published_at = ${to === 'published' ? sql`coalesce(published_at, now())` : sql`NULL`},
               updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id, product_id, rating`);
      const row = rows[0];
      if (!row) return failOne(['id'], 'NOT_FOUND', 'No review of the shop has this ID');
      await appendEvent<ProductReviewChangedPayload>(tx, tenant.shopId, {
        type: to === 'published' ? ReviewEvents.Published : ReviewEvents.Hidden,
        aggregateType: 'product_review',
        aggregateId: id,
        payload: { productId: row.product_id, rating: row.rating, status: to },
      });
      const { rows: shown } = await tx.execute<ReviewRow>(sql`
        SELECT ${COLUMNS}
          FROM catalog.product_reviews r
          JOIN catalog.products p ON p.shop_id = r.shop_id AND p.id = r.product_id
         WHERE r.shop_id = ${tenant.shopId} AND r.id = ${id}`);
      return { ok: true, value: toRecord(shown[0]!) };
    });
  }

  /** How the shop takes reviews: from how many stars they publish, and when it asks for them. */
  async settings(tenant: TenantContext): Promise<ReviewSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => reviewSettingsIn(tx, tenant.shopId));
  }

  /**
   * Sets from how many stars, 3, 4 or 5, reviews publish by themselves, or none; and how many days
   * after delivery, 1 to 30, the shop asks for them on WhatsApp, or never. What is not given stays.
   */
  async updateSettings(
    tenant: TenantContext,
    input: Partial<ReviewSettingsRecord>,
  ): Promise<MutationResult<ReviewSettingsRecord>> {
    const check = new InputChecker();
    const { publishFrom, requestAfterDays } = input;
    if (
      publishFrom !== undefined &&
      publishFrom !== null &&
      !(PUBLISH_FROM as readonly number[]).includes(publishFrom)
    ) {
      check.add(['publishFrom'], 'INVALID', 'must be 3, 4 or 5 stars, or none');
    }
    if (
      requestAfterDays !== undefined &&
      requestAfterDays !== null &&
      !(
        Number.isInteger(requestAfterDays) &&
        requestAfterDays >= 1 &&
        requestAfterDays <= REVIEW_LIMITS.requestAfterDays
      )
    ) {
      check.add(['requestAfterDays'], 'INVALID', 'must be 1 to 14 days, or none');
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await reviewSettingsIn(tx, tenant.shopId);
      const after: ReviewSettingsRecord = {
        publishFrom: publishFrom === undefined ? before.publishFrom : publishFrom,
        requestAfterDays:
          requestAfterDays === undefined ? before.requestAfterDays : requestAfterDays,
      };
      if (
        after.publishFrom === before.publishFrom &&
        after.requestAfterDays === before.requestAfterDays
      ) {
        return { ok: true, value: before };
      }
      await tx.execute(sql`
        INSERT INTO catalog.review_settings (shop_id, publish_from, request_after_days)
        VALUES (${tenant.shopId}, ${after.publishFrom}, ${after.requestAfterDays})
        ON CONFLICT (shop_id) DO UPDATE
              SET publish_from = excluded.publish_from,
                  request_after_days = excluded.request_after_days, updated_at = now()`);
      await appendEvent(tx, tenant.shopId, {
        type: ReviewEvents.SettingsUpdated,
        aggregateType: 'review_settings',
        aggregateId: tenant.shopId,
        payload: { ...after },
      });
      await recordAudit(tx, tenant.shopId, {
        action: ReviewEvents.SettingsUpdated,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: { ...after, before },
      });
      return { ok: true, value: after };
    });
  }
}

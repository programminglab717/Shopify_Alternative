import { appendEvent } from '@hatti/events';
import { toDate, type Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

/** Events of products' reviews. Payloads are thin: fetch current state through the API. */
export const ReviewEvents = {
  /** A customer rated a product, or changed what they said. */
  Written: 'product_review.written',
  Published: 'product_review.published',
  Hidden: 'product_review.hidden',
  SettingsUpdated: 'review_settings.updated',
} as const;

/** A review written, published or hidden: its product, whose storefront page shows it. */
export interface ProductReviewChangedPayload {
  productId: string;
  rating: number;
  status: ReviewStatusValue;
}

export type ReviewStatusValue = 'pending' | 'published' | 'hidden';

/**
 * How long a review's words may be, how many a page lists, and how long after delivery a shop may
 * ask for one at most.
 */
export const REVIEW_LIMITS = {
  body: 2_000,
  name: 100,
  page: 50,
  requestAfterDays: 14,
  /** How many of a product's published reviews its storefront page shows. */
  shown: 10,
} as const;

/**
 * A customer's name as their reviews show it: their first name and their surname's initial,
 * "Ayesha K."; a name of one word as it is; none, "A customer".
 */
export function reviewAuthorName(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'A customer';
  const first = words[0]!.slice(0, REVIEW_LIMITS.name - 3);
  return words.length === 1 ? first : `${first} ${[...words.at(-1)!][0]!.toUpperCase()}.`;
}

/** What a customer gives of a product they bought: stars, and words if they like. */
export interface ReviewInput {
  productId: string;
  rating: number;
  body: string | null;
}

/** A review an order's customer wrote, as their order's page shows it back. */
export interface OrderReview {
  productId: string;
  rating: number;
  body: string | null;
  status: ReviewStatusValue;
}

/** How the shop takes reviews (ADR-399, ADR-400). */
export interface ReviewSettingsRecord {
  /** The stars it publishes by itself, and more; null: every review waits for it. */
  publishFrom: number | null;
  /** How many days after delivery it asks for a review on WhatsApp; null: it does not. */
  requestAfterDays: number | null;
}

/** The shop's review settings, in the caller's transaction `tx`. */
export async function reviewSettingsIn(tx: Tx, shopId: string): Promise<ReviewSettingsRecord> {
  const { rows } = await tx.execute<{
    publish_from: number | null;
    request_after_days: number | null;
  }>(sql`
    SELECT publish_from, request_after_days FROM catalog.review_settings
     WHERE shop_id = ${shopId}`);
  return {
    publishFrom: rows[0]?.publish_from ?? null,
    requestAfterDays: rows[0]?.request_after_days ?? null,
  };
}

/** The stars the shop publishes by itself, if any (null: every review waits for it). */
export async function publishFromIn(tx: Tx, shopId: string): Promise<number | null> {
  return (await reviewSettingsIn(tx, shopId)).publishFrom;
}

/**
 * Keeps what an order's customer says of the products they bought (MKT-05, ADR-399): one review
 * an order and product, the same again changing it. A review of as many stars as the shop
 * publishes by itself is published; any other waits for the shop, a changed one again. Products
 * deleted since are passed over. How many it kept.
 */
export async function writeReviewsIn(
  tx: Tx,
  shopId: string,
  order: { id: string; customerId: string | null; authorName: string },
  reviews: readonly ReviewInput[],
): Promise<number> {
  const publishFrom = await publishFromIn(tx, shopId);
  let kept = 0;
  for (const review of reviews) {
    if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) continue;
    const body = review.body?.trim().slice(0, REVIEW_LIMITS.body) || null;
    const status: ReviewStatusValue =
      publishFrom !== null && review.rating >= publishFrom ? 'published' : 'pending';
    const { rows } = await tx.execute<{ id: string; changed: boolean }>(sql`
      INSERT INTO catalog.product_reviews
             (shop_id, product_id, order_id, customer_id, author_name, rating, body, status,
              published_at)
      SELECT ${shopId}, p.id, ${order.id}, ${order.customerId}, ${order.authorName},
             ${review.rating}, ${body}, ${status},
             ${status === 'published' ? sql`now()` : sql`NULL`}
        FROM catalog.products p
       WHERE p.shop_id = ${shopId} AND p.id = ${review.productId}
      ON CONFLICT (shop_id, order_id, product_id) DO UPDATE
         SET rating = excluded.rating, body = excluded.body, status = excluded.status,
             published_at = excluded.published_at, updated_at = now()
       WHERE (catalog.product_reviews.rating, catalog.product_reviews.body)
             IS DISTINCT FROM (excluded.rating, excluded.body)
      RETURNING id, true AS changed`);
    const row = rows[0];
    if (!row) continue;
    kept += 1;
    await appendEvent<ProductReviewChangedPayload>(tx, shopId, {
      type: ReviewEvents.Written,
      aggregateType: 'product_review',
      aggregateId: row.id,
      payload: { productId: review.productId, rating: review.rating, status },
    });
  }
  return kept;
}

/** What an order's customer said of the products they bought, by product. */
export async function reviewsOfOrderIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderReview[]> {
  const { rows } = await tx.execute<{
    product_id: string;
    rating: number;
    body: string | null;
    status: ReviewStatusValue;
  }>(sql`
    SELECT product_id, rating, body, status FROM catalog.product_reviews
     WHERE shop_id = ${shopId} AND order_id = ${orderId}
     ORDER BY created_at, id`);
  return rows.map((row) => ({
    productId: row.product_id,
    rating: row.rating,
    body: row.body,
    status: row.status,
  }));
}

/** A customer's reviews, as their own file lists them (CUS-05). */
export async function reviewsOfCustomerIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<{ product: string; rating: number; body: string | null; at: Date }[]> {
  const { rows } = await tx.execute<{
    title: string;
    rating: number;
    body: string | null;
    created_at: string | Date;
  }>(sql`
    SELECT p.title, r.rating, r.body, r.created_at
      FROM catalog.product_reviews r
      JOIN catalog.products p ON p.shop_id = r.shop_id AND p.id = r.product_id
     WHERE r.shop_id = ${shopId} AND r.customer_id = ${customerId}
     ORDER BY r.created_at, r.id`);
  return rows.map((row) => ({
    product: row.title,
    rating: row.rating,
    body: row.body,
    at: toDate(row.created_at),
  }));
}

/** A duplicate customer merged into another (CUS-01): their reviews become the other's. */
export async function mergeReviewsIn(
  tx: Tx,
  shopId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE catalog.product_reviews SET customer_id = ${intoId}
     WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
}

/** A customer erased (CUS-05): the reviews they wrote go with them. How many went. */
export async function eraseReviewsIn(tx: Tx, shopId: string, customerId: string): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    DELETE FROM catalog.product_reviews
     WHERE shop_id = ${shopId} AND customer_id = ${customerId}
    RETURNING id`);
  return rows.length;
}

/** A product's published reviews, as its storefront page shows them (ADR-401). */
export interface ShownReviews {
  /** Their average stars, to one decimal place. */
  rating: number;
  count: number;
  /** The latest published, newest first, at most {@link REVIEW_LIMITS.shown}. */
  latest: { id: string; author: string; rating: number; body: string | null; publishedAt: Date }[];
}

/**
 * The published reviews of each of `productIds` that has any, for its storefront page (ADR-401):
 * their average and count, and the latest, newest first.
 */
export async function shownReviewsIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, ShownReviews>> {
  const shown = new Map<string, ShownReviews>();
  if (productIds.length === 0) return shown;
  const { rows: totals } = await tx.execute<{
    product_id: string;
    rating: string | number;
    count: number;
  }>(sql`
    SELECT product_id, round(avg(rating), 1) AS rating, count(*)::int AS count
      FROM catalog.product_reviews
     WHERE shop_id = ${shopId} AND product_id = ANY(${sql.param(productIds)}::uuid[])
       AND status = 'published'
     GROUP BY product_id`);
  if (totals.length === 0) return shown;
  const { rows: latest } = await tx.execute<{
    id: string;
    product_id: string;
    author_name: string;
    rating: number;
    body: string | null;
    published_at: string | Date;
  }>(sql`
    SELECT id, product_id, author_name, rating, body, published_at FROM (
      SELECT r.*, row_number() OVER (PARTITION BY product_id
                                     ORDER BY published_at DESC, id DESC) AS place
        FROM catalog.product_reviews r
       WHERE shop_id = ${shopId}
         AND product_id = ANY(${sql.param(totals.map((row) => row.product_id))}::uuid[])
         AND status = 'published') ranked
     WHERE place <= ${REVIEW_LIMITS.shown}
     ORDER BY product_id, place`);
  for (const total of totals) {
    shown.set(total.product_id, {
      rating: Number(total.rating),
      count: total.count,
      latest: latest
        .filter((row) => row.product_id === total.product_id)
        .map((row) => ({
          id: row.id,
          author: row.author_name,
          rating: row.rating,
          body: row.body,
          publishedAt: toDate(row.published_at),
        })),
    });
  }
  return shown;
}

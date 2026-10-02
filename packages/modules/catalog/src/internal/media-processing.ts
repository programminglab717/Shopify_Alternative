import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { and, eq, sql } from 'drizzle-orm';
import { CatalogEvents, type ProductUpdatedPayload } from './events.js';
import { products, type ImageFormatValue } from './schema.js';

/** A media the worker took, to make its image ready. */
export interface ClaimedMedia {
  id: string;
  productId: string;
  sourceUrl: string;
  /** The file the shop uploaded, when it did: read from storage rather than fetched. */
  sourceKey: string | null;
  /** Its tries, this one counted. */
  attempts: number;
}

/** A clean copy the worker kept (ADR-158). */
export interface ProcessedImage {
  format: ImageFormatValue;
  width: number;
  height: number;
  /** In bytes. */
  size: number;
}

/** What came of marking an image ready: done, already settled by another try, or gone. */
export type ReadyOutcome = 'ready' | 'settled' | 'gone';

/** The most of a failure's message kept. */
const MESSAGE_LENGTH = 500;

/**
 * Products' images on their way to ready (ADR-158), for the worker: the shops with some due, a
 * batch of a shop's taken at a time, and what came of each. An image ready, or failed, changes
 * what the storefront shows: the product's `product.updated`, its media changed.
 */
export class MediaProcessing {
  constructor(private readonly db: Database) {}

  /** Shops with images due at `at`, across shops. */
  async dueShops(at: Date, limit = 100): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM catalog.product_media
         WHERE next_attempt_at <= ${at.toISOString()}
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Takes up to `limit` of the shop's images due at `at`, the longest waiting first: each is
   * processing, counts a try, and is not due again for `leaseMs` unless settled before. No two
   * workers take the same, and one that stops before settling has them tried again after that.
   */
  async claim(shopId: string, at: Date, limit: number, leaseMs: number): Promise<ClaimedMedia[]> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{
        id: string;
        product_id: string;
        source_url: string;
        source_key: string | null;
        attempts: number;
      }>(sql`
        -- Chosen once: a subquery in UPDATE's FROM may be run again, and take more.
        WITH due AS MATERIALIZED (
          SELECT id FROM catalog.product_media
           WHERE shop_id = ${shopId} AND next_attempt_at <= ${at.toISOString()}
           ORDER BY next_attempt_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)
        UPDATE catalog.product_media m
           SET status = 'processing',
               attempts = m.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + leaseMs).toISOString()},
               updated_at = now()
          FROM due
         WHERE m.shop_id = ${shopId} AND m.id = due.id
        RETURNING m.id, m.product_id, m.source_url, m.source_key, m.attempts`),
    );
    return (
      rows
        .map((row) => ({
          id: row.id,
          productId: row.product_id,
          sourceUrl: row.source_url,
          sourceKey: row.source_key,
          attempts: row.attempts,
        }))
        // The first added first: their IDs follow the time they were made.
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    );
  }

  /** Marks a taken image ready, its clean copy as given. */
  async ready(shopId: string, mediaId: string, image: ProcessedImage): Promise<ReadyOutcome> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ product_id: string }>(sql`
        UPDATE catalog.product_media
           SET status = 'ready', image_format = ${image.format}, image_size = ${image.size},
               width = ${image.width}, height = ${image.height}, next_attempt_at = NULL,
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${mediaId} AND status = 'processing'
        RETURNING product_id`);
      if (rows[0]) {
        await imagesChanged(tx, shopId, rows[0].product_id);
        return 'ready';
      }
      const { rows: found } = await tx.execute(sql`
        SELECT 1 FROM catalog.product_media WHERE shop_id = ${shopId} AND id = ${mediaId}`);
      return found.length > 0 ? 'settled' : 'gone';
    });
  }

  /** Has a taken image tried again at `at`. */
  async retryAt(shopId: string, mediaId: string, at: Date): Promise<void> {
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        UPDATE catalog.product_media SET next_attempt_at = ${at.toISOString()}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${mediaId} AND status = 'processing'`),
    );
  }

  /** Marks a taken image failed, saying why, in Shopify's `MediaError`'s words. */
  async failed(shopId: string, mediaId: string, error: { code: string; message: string }) {
    await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ product_id: string }>(sql`
        UPDATE catalog.product_media
           SET status = 'failed', error_code = ${error.code},
               error_message = ${error.message.slice(0, MESSAGE_LENGTH)},
               next_attempt_at = NULL, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${mediaId} AND status = 'processing'
        RETURNING product_id`);
      if (rows[0]) await imagesChanged(tx, shopId, rows[0].product_id);
    });
  }

  /** Media gone, the oldest first, across shops: their images are still to be removed. */
  async removals(limit: number): Promise<{ shopId: string; mediaId: string }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; media_id: string }>(sql`
        SELECT shop_id, media_id FROM catalog.media_removals
         ORDER BY created_at, media_id
         LIMIT ${limit}`),
    );
    return rows.map((row) => ({ shopId: row.shop_id, mediaId: row.media_id }));
  }

  /** Records that the images of media gone were removed. */
  async removed(shopId: string, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        DELETE FROM catalog.media_removals
         WHERE shop_id = ${shopId} AND media_id = ANY(${sql.param([...mediaIds])}::uuid[])`),
    );
  }
}

/**
 * Records that a product's images changed, as the worker found them: bumps its version and
 * records `product.updated`, so the storefront shows them as they are now. No collection's rules
 * look at images, so memberships stay as they are.
 */
async function imagesChanged(tx: Tx, shopId: string, productId: string): Promise<void> {
  const [updated] = await tx
    .update(products)
    .set({ version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(products.shopId, shopId), eq(products.id, productId)))
    .returning({ version: products.version });
  if (!updated) return;
  await appendEvent<ProductUpdatedPayload>(tx, shopId, {
    type: CatalogEvents.ProductUpdated,
    aggregateType: 'product',
    aggregateId: productId,
    payload: { changed: ['media'], version: updated.version },
  });
}

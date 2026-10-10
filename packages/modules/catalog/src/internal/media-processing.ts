import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { and, eq, sql } from 'drizzle-orm';
import { CatalogEvents, type ProductUpdatedPayload } from './events.js';
import type { MediaCropRecord, VideoRecord } from './records.js';
import { products, type ImageFormatValue, type MediaTypeValue } from './schema.js';
import type { VideoHostValue } from './videos.js';

/** A media the worker took, to make its image ready, and a video's file. */
export interface ClaimedMedia {
  id: string;
  productId: string;
  /** An image; a video the shop uploaded; a YouTube or Vimeo video (ADR-258). */
  mediaType: MediaTypeValue;
  /** An image's, or a video the shop uploaded, or a YouTube or Vimeo video's address. */
  sourceUrl: string;
  /** The file the shop uploaded, when it did: read from storage rather than fetched. */
  sourceKey: string | null;
  /** A video's preview image, where it was given: as `sourceUrl` and `sourceKey` are. */
  previewSourceUrl: string | null;
  previewSourceKey: string | null;
  /** A YouTube or Vimeo video's host and ID. */
  externalVideo: { host: VideoHostValue; id: string } | null;
  /** Its tries, this one counted. */
  attempts: number;
  /**
   * What is kept of the media it is a copy of, a product duplicated (ADR-343), while that one is
   * ready: the clean copy's format, its crop, and whether a video the shop uploaded is kept.
   */
  copyOf: CopiedMedia | null;
}

/** The ready media a copy is made from. */
export interface CopiedMedia {
  id: string;
  format: ImageFormatValue;
  crop: MediaCropRecord | null;
  video: boolean;
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
 * Products' images and videos on their way to ready (ADR-158, ADR-258), for the worker: the shops
 * with some due, a batch of a shop's taken at a time, and what came of each. A media ready, or
 * failed, changes what the storefront shows: the product's `product.updated`, its media changed.
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
        media_type: MediaTypeValue;
        source_url: string;
        source_key: string | null;
        preview_source_url: string | null;
        preview_source_key: string | null;
        video_host: VideoHostValue | null;
        video_external_id: string | null;
        attempts: number;
        copy_of: {
          id: string;
          format: ImageFormatValue;
          left: number | null;
          top: number | null;
          width: number | null;
          height: number | null;
          video: boolean;
        } | null;
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
        RETURNING m.id, m.product_id, m.media_type, m.source_url, m.source_key,
                  m.preview_source_url, m.preview_source_key, m.video_host, m.video_external_id,
                  m.attempts,
                  (SELECT jsonb_build_object(
                            'id', o.id, 'format', o.image_format, 'left', o.crop_left,
                            'top', o.crop_top, 'width', o.crop_width, 'height', o.crop_height,
                            'video', o.video_size IS NOT NULL)
                     FROM catalog.product_media o
                    WHERE o.shop_id = m.shop_id AND o.id = m.copied_from
                      AND o.status = 'ready') AS copy_of`),
    );
    return (
      rows
        .map((row) => ({
          id: row.id,
          productId: row.product_id,
          mediaType: row.media_type,
          sourceUrl: row.source_url,
          sourceKey: row.source_key,
          previewSourceUrl: row.preview_source_url,
          previewSourceKey: row.preview_source_key,
          externalVideo:
            row.video_host && row.video_external_id
              ? { host: row.video_host, id: row.video_external_id }
              : null,
          attempts: row.attempts,
          copyOf: row.copy_of && {
            id: row.copy_of.id,
            format: row.copy_of.format,
            crop:
              row.copy_of.left === null
                ? null
                : {
                    left: row.copy_of.left,
                    top: row.copy_of.top!,
                    width: row.copy_of.width!,
                    height: row.copy_of.height!,
                  },
            video: row.copy_of.video,
          },
        }))
        // The first added first: their IDs follow the time they were made.
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    );
  }

  /**
   * Marks a taken media ready, its image's clean copy as given: an image's own, or a video's
   * preview; a video the shop uploaded, as kept (ADR-258); and the crop of the one it copies,
   * its crop's clean copy kept (ADR-343).
   */
  async ready(
    shopId: string,
    mediaId: string,
    image: ProcessedImage,
    video: VideoRecord | null = null,
    crop: MediaCropRecord | null = null,
  ): Promise<ReadyOutcome> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ product_id: string }>(sql`
        UPDATE catalog.product_media
           SET status = 'ready', image_format = ${image.format}, image_size = ${image.size},
               width = ${image.width}, height = ${image.height}, next_attempt_at = NULL,
               video_size = ${video?.size ?? null}, video_width = ${video?.width ?? null},
               video_height = ${video?.height ?? null},
               video_duration_ms = ${video?.durationMs ?? null}, crop_left = ${crop?.left ?? null},
               crop_top = ${crop?.top ?? null}, crop_width = ${crop?.width ?? null},
               crop_height = ${crop?.height ?? null}, updated_at = now()
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

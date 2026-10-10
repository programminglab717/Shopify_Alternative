/** What a product's copy takes of it besides its own rows (ADR-343). */
import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { CatalogEvents, type CollectionUpdatedPayload } from './events.js';
import type { ProductRecord } from './records.js';

/** A variant of a product duplicated, and its copy's. */
export interface VariantCopy {
  /** The product's variant. */
  from: string;
  /** Its copy's. */
  to: string;
  /** The copy. */
  productId: string;
}

/**
 * Copies the stock settings of a duplicated product's variants to their copies' in the
 * duplicate's transaction: whether each is tracked and sells on when out of stock, with none of
 * its stock. The inventory module keeps them, which the catalog cannot reach. Without it, as in
 * the catalog's own tests, a copy's variants are untracked until their stock is first set.
 */
export abstract class CopiedVariantStock {
  abstract copy(tx: Tx, shopId: string, copies: readonly VariantCopy[]): Promise<void>;
}

/**
 * The product's photos and videos copied to its copy, where they were: each made again by the
 * worker, from what was kept of the one it copies where that is still there, as the file the
 * shop uploaded is swept a day after, else from its source; its focal point kept, and its crop
 * once made, as only a ready image is cropped. Each variant shows its photo's copy.
 */
export async function copyMedia(
  tx: Tx,
  shopId: string,
  original: ProductRecord,
  copyId: string,
  copies: readonly VariantCopy[],
): Promise<void> {
  if (original.media.length === 0) return;
  const ids = new Map(original.media.map((media) => [media.id, newId()]));
  await tx.execute(sql`
    INSERT INTO catalog.product_media
           (shop_id, id, product_id, media_type, source_url, source_key, alt, position,
            focal_x, focal_y, preview_source_url, preview_source_key, video_host,
            video_external_id, copied_from)
    SELECT m.shop_id, u.new_id, ${copyId}, m.media_type, m.source_url, m.source_key, m.alt,
           m.position, m.focal_x, m.focal_y, m.preview_source_url, m.preview_source_key,
           m.video_host, m.video_external_id, m.id
      FROM unnest(${sql.param([...ids.keys()])}::uuid[], ${sql.param([...ids.values()])}::uuid[])
           AS u(old_id, new_id)
      JOIN catalog.product_media m ON m.shop_id = ${shopId} AND m.id = u.old_id
     ORDER BY m.position`);
  const shown = copies.flatMap(({ from, to }) => {
    const mediaId = original.variants.find((variant) => variant.id === from)?.mediaId;
    const copied = mediaId ? ids.get(mediaId) : undefined;
    return copied ? [{ variantId: to, mediaId: copied }] : [];
  });
  if (shown.length === 0) return;
  await tx.execute(sql`
    UPDATE catalog.variants v SET media_id = u.media_id
      FROM unnest(${sql.param(shown.map(({ variantId }) => variantId))}::uuid[],
                  ${sql.param(shown.map(({ mediaId }) => mediaId))}::uuid[])
           AS u(variant_id, media_id)
     WHERE v.shop_id = ${shopId} AND v.id = u.variant_id`);
}

/**
 * The copy put last in each manual collection the product is in, as staff add products to one;
 * smart collections take it by their rules.
 */
export async function joinManualCollections(
  tx: Tx,
  shopId: string,
  originalId: string,
  copyId: string,
): Promise<void> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT c.id FROM catalog.collections c
     WHERE c.shop_id = ${shopId} AND c.rules IS NULL
       AND EXISTS (SELECT 1 FROM catalog.collection_products cp
                    WHERE cp.shop_id = c.shop_id AND cp.collection_id = c.id
                      AND cp.product_id = ${originalId})
     ORDER BY c.id
       FOR UPDATE`);
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  await tx.execute(sql`
    INSERT INTO catalog.collection_products (shop_id, collection_id, product_id, position)
    SELECT ${shopId}, c.id, ${copyId},
           coalesce((SELECT max(position) FROM catalog.collection_products
                      WHERE shop_id = ${shopId} AND collection_id = c.id), 0) + 1
      FROM unnest(${sql.param(ids)}::uuid[]) AS c(id)
        ON CONFLICT DO NOTHING`);
  const { rows: updated } = await tx.execute<{ id: string; version: number }>(sql`
    UPDATE catalog.collections SET version = version + 1, updated_at = now()
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])
    RETURNING id, version`);
  for (const collection of updated) {
    await appendEvent<CollectionUpdatedPayload>(tx, shopId, {
      type: CatalogEvents.CollectionUpdated,
      aggregateType: 'collection',
      aggregateId: collection.id,
      payload: { changed: ['products'], version: collection.version },
    });
  }
}

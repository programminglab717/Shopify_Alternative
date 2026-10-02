import {
  cleanImageKey,
  imagesPrefixOf,
  type ClaimedMedia,
  type MediaProcessing,
} from '@hatti/catalog/public';
import {
  CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  cleanImage,
  type FetchResult,
  type ImageFetcher,
} from '@hatti/images';
import type { Logger } from '@hatti/logger';
import type { ObjectStorage } from '@hatti/storage';
import { imageTag } from '@hatti/storefront-data';
import { NO_EDGE_CACHE, type EdgeCache } from '../storefront/edge-cache.js';
import { repeat } from './repeat.js';

/** Images a round takes from a shop, and media gone whose images it removes. */
const BATCH = 10;
const REMOVALS = 100;
/** How long a taken image is the taker's: longer than the slowest fetch and check. */
const LEASE_MS = 5 * 60_000;
/** Tries at a source that does not answer, over about half an hour, before the image fails. */
export const IMAGE_ATTEMPTS = 6;

/** How long until an image whose source did not answer is tried again: a minute, doubling. */
export function imageRetryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 30 * 60_000);
}

export interface ProductImagesOptions {
  processing: MediaProcessing;
  storage: ObjectStorage;
  fetcher: Pick<ImageFetcher, 'fetch'>;
  /** The edge in front of the images, which forgets those removed. */
  edge?: EdgeCache;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Makes products' images ready (CAT-02, ADR-158): reads each from the file the shop uploaded, or
 * fetches it from its URL, never from a private network; checks it is an image to show; and
 * keeps its clean copy, which the API makes every size and format of as browsers ask. An image
 * that is not one to show fails at once, saying why; a source that does not answer is tried
 * again, for about half an hour. Media gone have their images removed from storage and the edge.
 */
export class ProductImages {
  constructor(private readonly options: ProductImagesOptions) {}

  /** One round: every shop with images due has a batch made ready; then removals. */
  async sweep(at: Date = new Date()): Promise<{ ready: number; removed: number }> {
    const { processing, logger } = this.options;
    let ready = 0;
    for (const shopId of await processing.dueShops(at)) {
      try {
        ready += await this.process(shopId, at);
      } catch (error) {
        // One shop's failure is not the others': its images are due again after their lease.
        logger?.warn({ err: error, shopId }, 'product images not made ready');
      }
    }
    return { ready, removed: await this.remove() };
  }

  /** Makes a batch of the shop's images due at `at` ready. How many were. */
  async process(shopId: string, at: Date): Promise<number> {
    const claimed = await this.options.processing.claim(shopId, at, BATCH, LEASE_MS);
    let ready = 0;
    for (const media of claimed) {
      if (await this.#processOne(shopId, media, at)) ready += 1;
    }
    return ready;
  }

  /** Removes the images of media gone, a batch of them. How many media's. */
  async remove(): Promise<number> {
    const { processing, storage, edge = NO_EDGE_CACHE } = this.options;
    const gone = await processing.removals(REMOVALS);
    if (gone.length === 0) return 0;
    for (const { shopId, mediaId } of gone)
      await storage.deletePrefix(imagesPrefixOf(shopId, mediaId));
    await edge.purge(gone.map(({ shopId, mediaId }) => imageTag(shopId, mediaId)));
    const byShop = new Map<string, string[]>();
    for (const { shopId, mediaId } of gone) {
      byShop.set(shopId, [...(byShop.get(shopId) ?? []), mediaId]);
    }
    for (const [shopId, mediaIds] of byShop) await processing.removed(shopId, mediaIds);
    return gone.length;
  }

  /** Makes now, every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'product images sweep failed'),
    );
  }

  /** Whether the image is ready now. */
  async #processOne(shopId: string, media: ClaimedMedia, at: Date): Promise<boolean> {
    const { processing, storage } = this.options;
    const source = await this.#read(shopId, media);
    if (!source.ok) {
      if (source.transient && media.attempts < IMAGE_ATTEMPTS) {
        const next = new Date(at.getTime() + imageRetryDelayMs(media.attempts));
        await processing.retryAt(shopId, media.id, next);
      } else {
        await processing.failed(shopId, media.id, source);
      }
      return false;
    }
    const cleaned = await cleanImage(source.body);
    if (!cleaned.ok) {
      await processing.failed(shopId, media.id, cleaned.problem);
      return false;
    }
    const { image } = cleaned;
    await storage.put(
      cleanImageKey(shopId, media.id, image.format),
      image.body,
      CONTENT_TYPES[image.format],
    );
    const outcome = await processing.ready(shopId, media.id, {
      format: image.format,
      width: image.width,
      height: image.height,
      size: image.body.length,
    });
    // Gone while it was made: what was kept of it goes too.
    if (outcome === 'gone') await storage.deletePrefix(imagesPrefixOf(shopId, media.id));
    return outcome === 'ready';
  }

  /** The image's bytes: from the shop's own upload, or fetched from its URL. */
  async #read(shopId: string, media: ClaimedMedia): Promise<FetchResult> {
    if (media.sourceKey === null) return this.options.fetcher.fetch(media.sourceUrl);
    const gone = 'The uploaded file is gone: upload it again';
    // The database checks it too: the shop's own files alone.
    if (!media.sourceKey.startsWith(`shops/${shopId}/files/`)) {
      return { ok: false, transient: false, code: 'IMAGE_DOWNLOAD_FAILURE', message: gone };
    }
    const stored = await this.options.storage.head(media.sourceKey);
    if (stored && stored.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        transient: false,
        code: 'INVALID_IMAGE_FILE_SIZE',
        message: 'The image is over 20 MB',
      };
    }
    const file = stored && (await this.options.storage.read(media.sourceKey));
    if (!file)
      return { ok: false, transient: false, code: 'IMAGE_DOWNLOAD_FAILURE', message: gone };
    return { ok: true, body: file.body };
  }
}

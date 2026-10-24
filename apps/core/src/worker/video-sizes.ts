import { videoKeyOf, type ClaimedVideo, type MediaProcessing } from '@hatti/catalog/public';
import { VideoSizeError, type VideoSizer } from '@hatti/images';
import type { Logger } from '@hatti/logger';
import type { ObjectStorage } from '@hatti/storage';
import { repeat } from './repeat.js';

/** Videos a round takes from a shop: each is minutes of work. */
const BATCH = 2;
/** How long a taken video is the taker's: longer than the slowest of its copies. */
const LEASE_MS = 30 * 60_000;

export interface VideoSizesOptions {
  processing: MediaProcessing;
  storage: ObjectStorage;
  sizer: Pick<VideoSizer, 'copies'>;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Makes the smaller copies of products' videos (CAT-02, ADR-791): each video ready, as uploaded,
 * is read from storage and made at the short sides below its own by ffmpeg, the copies kept
 * beside it; its product's pages then offer them to smaller screens. A video ffmpeg cannot make
 * smaller keeps playing as uploaded, with none, said in the log; a worker that stops leaves it
 * to the next, once its lease is up.
 */
export class VideoSizes {
  constructor(private readonly options: VideoSizesOptions) {}

  /** One round: every shop with videos due has a batch made smaller. How many were. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { processing, logger } = this.options;
    let sized = 0;
    for (const shopId of await processing.videoShops(at)) {
      try {
        for (const video of await processing.claimVideos(shopId, at, BATCH, LEASE_MS)) {
          if (await this.#size(shopId, video)) sized += 1;
        }
      } catch (error) {
        // One shop's failure is not the others': its videos are due again after their lease.
        logger?.warn({ err: error, shopId }, 'video sizes not made');
      }
    }
    return sized;
  }

  /** Makes now, every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.options.logger?.warn({ err: error }, 'video sizes sweep failed'),
    );
  }

  /** Whether `video` had copies made, or was settled with none. */
  async #size(shopId: string, video: ClaimedVideo): Promise<boolean> {
    const { processing, storage, sizer, logger } = this.options;
    const original = await storage.read(videoKeyOf(shopId, video.id));
    if (!original) return processing.videoSized(shopId, video.id, []);
    let copies;
    try {
      copies = await sizer.copies({
        body: original.body,
        width: video.width,
        height: video.height,
      });
    } catch (error) {
      if (!(error instanceof VideoSizeError)) throw error;
      logger?.warn({ err: error, shopId, mediaId: video.id }, 'video kept without smaller sizes');
      return processing.videoSized(shopId, video.id, []);
    }
    for (const copy of copies) {
      await storage.put(videoKeyOf(shopId, video.id, copy.short), copy.body, 'video/mp4');
    }
    const kept = await processing.videoSized(
      shopId,
      video.id,
      copies.map(({ short, width, height, body }) => ({ short, width, height, size: body.length })),
    );
    // Gone, or made ready again meanwhile: these copies are of nothing shown.
    if (!kept) {
      await Promise.all(
        copies.map((copy) => storage.delete(videoKeyOf(shopId, video.id, copy.short))),
      );
    }
    return kept;
  }
}

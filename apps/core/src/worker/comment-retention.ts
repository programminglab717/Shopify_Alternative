import type { Logger } from '@hatti/logger';
import type { CommentService } from '@hatti/online-store/public';
import { repeat } from './repeat.js';

/** Comments cleared at a time: each a short statement, never a long lock on the comments. */
const BATCH = 1_000;

/** Forgets the address and browser of up to `limit` comments past their time, and says how many. */
export type ForgetAddresses = (at: Date, limit: number) => Promise<number>;

/**
 * Forgets the internet address and browser a comment on an article was posted from 90 days after
 * (ADR-748), a batch at a time until a batch comes back short, across shops. The comment is kept:
 * the address was for the shop judging it, long done by then.
 */
export class CommentAddressRetention {
  readonly #forget: ForgetAddresses;

  constructor(
    comments: Pick<CommentService, 'forgetAddresses'> | ForgetAddresses,
    private readonly logger?: Logger,
  ) {
    this.#forget =
      typeof comments === 'function'
        ? comments
        : (at, limit) => comments.forgetAddresses(at, limit);
  }

  /** One sweep at `at`: how many comments' addresses it forgot. */
  async sweep(at: Date = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const cleared = await this.#forget(at, BATCH);
      total += cleared;
      if (cleared < BATCH) break;
    }
    if (total > 0)
      this.logger?.info({ cleared: total }, 'comments past ninety days forgot their addresses');
    return total;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'comment address sweep failed'),
    );
  }
}

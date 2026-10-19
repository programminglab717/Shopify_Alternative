import type { AccountDataExpiry } from '@hatti/checkout/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Lets go of the files of their own data shoppers asked for from their accounts (ADR-572) once
 * their day is up, or once their customer was merged or erased: storage deletes each, across
 * shops, a batch at a time until a batch comes back short. One that could not be let go is logged,
 * and tried again on the next sweep.
 */
export class AccountDataFiles {
  constructor(
    private readonly expiry: AccountDataExpiry,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many files it let go. */
  async sweep(at: Date = new Date(), batch = 100): Promise<number> {
    let total = 0;
    for (;;) {
      let failures = 0;
      const deleted = await this.expiry.deleteExpired(at, batch, (shopId, error) => {
        failures += 1;
        this.logger?.warn({ err: error, shopId }, "shoppers' files of their data not let go");
      });
      total += deleted;
      // A short batch is the last; one with failures would only find them again.
      if (deleted + failures < batch || failures > 0) break;
    }
    if (total > 0) this.logger?.info({ deleted: total }, "shoppers' files of their data let go");
    return total;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, "shoppers' files sweep failed"),
    );
  }
}

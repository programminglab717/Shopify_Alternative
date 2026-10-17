import type { Db } from '@hatti/db';
import { endExpiredMemberships } from '@hatti/identity/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/** Collaborators' memberships a sweep ends at most. */
const BATCH = 200;

/**
 * Ends collaborators' access when it is due (ADM-07, ADR-487): each sweep takes away the
 * memberships past their end, across shops, through identity's own function. Access stops at the
 * end without it; the sweep takes them off the shop's staff.
 */
export class ExpiredMemberships {
  constructor(
    private readonly db: Pick<Db, 'execute'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many memberships it ended. */
  async sweep(): Promise<number> {
    let ended = 0;
    for (;;) {
      const batch = await endExpiredMemberships(this.db, BATCH);
      ended += batch;
      if (batch < BATCH) break;
    }
    if (ended > 0) this.logger?.info({ ended }, "collaborators' access ended");
    return ended;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'expired memberships sweep failed'),
    );
  }
}

import type { Logger } from '@hatti/logger';
import type { DomainCheck, DomainService } from '@hatti/online-store/public';
import { repeat } from './repeat.js';

/** Domains asked about at a time, and batches at most in a sweep. */
const BATCH = 100;
const BATCHES = 10;

/**
 * Asks DNS again about shops' verified domains (ADR-262), across shops, those due a batch at a
 * time until a batch comes back short: each through the online store's `recheck`, which tells
 * the shop of one DNS points elsewhere and disconnects it three days on. One domain's failure is
 * logged and not the others'; it is due again at the next sweep.
 */
export class DomainChecks {
  constructor(
    private readonly domains: Pick<DomainService, 'domainsToCheck' | 'recheck'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many domains came to each end. */
  async sweep(): Promise<Record<DomainCheck, number>> {
    const counts: Record<DomainCheck, number> = {
      pointed: 0,
      unpointed: 0,
      disconnected: 0,
      unanswered: 0,
      skipped: 0,
    };
    for (let batch = 0; batch < BATCHES; batch++) {
      const due = await this.domains.domainsToCheck(BATCH);
      for (const { shopId, id } of due) {
        try {
          const check = await this.domains.recheck(shopId, id);
          counts[check] += 1;
          if (check === 'unpointed' || check === 'disconnected') {
            this.logger?.info({ shopId, domainId: id, check }, 'domain pointed elsewhere');
          }
        } catch (error) {
          this.logger?.warn({ err: error, shopId, domainId: id }, 'domain not checked again');
        }
      }
      if (due.length < BATCH) break;
    }
    return counts;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'domain checks sweep failed'),
    );
  }
}

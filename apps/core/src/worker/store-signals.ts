import type { Logger } from '@hatti/logger';
import type { StoreSignalsService } from '@hatti/trust/public';
import { repeat } from './repeat.js';

/** How often the worker looks across stores for signs of scams: four times a day. */
export const SIGNALS_INTERVAL_MS = 6 * 3_600_000;

/**
 * Looks across stores for signs of a scam (TNS-02, ADR-842), for Hatti's people to look into:
 * a scan now, then every {@link SIGNALS_INTERVAL_MS}, never overlapping the last.
 */
export class StoreSignals {
  constructor(
    private readonly signals: Pick<StoreSignalsService, 'scan'>,
    private readonly logger?: Logger,
  ) {}

  async sweep(at: Date = new Date()): Promise<number> {
    const standing = await this.signals.scan(at);
    if (standing > 0) this.logger?.info({ standing }, 'signs of scam stores found');
    return standing;
  }

  start(intervalMs: number = SIGNALS_INTERVAL_MS): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'store signals scan failed'),
    );
  }
}

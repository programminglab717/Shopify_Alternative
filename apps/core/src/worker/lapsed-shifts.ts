import type { Logger } from '@hatti/logger';
import type { DeskDutyService } from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Hands over what waits on agents whose shift at the Confirmation Desk ran out without their
 * ending it (COD-04, ADR-666): each sweep, in every shop that shares new orders out, the orders
 * still waiting on them go to whoever is on duty with the fewest waiting.
 */
export class LapsedShifts {
  constructor(
    private readonly duty: Pick<DeskDutyService, 'handOverAllLapsed'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many orders it handed over. */
  async sweep(at: Date = new Date()): Promise<number> {
    const handed = await this.duty.handOverAllLapsed(at);
    if (handed > 0) this.logger?.info({ handed }, 'orders handed over from lapsed shifts');
    return handed;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'lapsed shifts sweep failed'),
    );
  }
}

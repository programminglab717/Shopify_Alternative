import type { Logger } from '@hatti/logger';
import type { ExpansionCopier } from '../expansion-copier.js';
import { repeat } from './repeat.js';

/**
 * Expansion stores kept in step (CH-11, ADR-913): each sweep, the links copying as products
 * change whose shop's products changed and were then left alone a while are copied, as the
 * shop's owner, within the hour.
 */
export class ExpansionAutoCopy {
  constructor(
    private readonly copier: Pick<ExpansionCopier, 'sweep'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many expansion stores it copied to. */
  async sweep(at: Date = new Date()): Promise<number> {
    const copied = await this.copier.sweep(at, this.logger);
    if (copied > 0) this.logger?.info({ copied }, 'expansion stores copied to');
    return copied;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'expansion stores sweep failed'),
    );
  }
}

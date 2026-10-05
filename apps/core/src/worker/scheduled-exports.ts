import type { Logger } from '@hatti/logger';
import type { ExportScheduleService, ScheduledExportSender } from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Sends the scheduled exports due (ORD-11, ADR-183): each sweep, every schedule whose period has
 * ended and whose hour has come, across shops, each as its own member of staff, through the
 * email service. One that fails is the schedule's to try again, not the sweep's.
 */
export class ScheduledExports {
  constructor(
    private readonly schedules: ExportScheduleService,
    private readonly emails: ScheduledExportSender,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of the schedules due at `at`: how many it sent. */
  async sweep(at: Date = new Date()): Promise<number> {
    let sent = 0;
    for (const { shopId, id } of await this.schedules.due(at)) {
      try {
        const outcome = await this.schedules.run(shopId, id, at, this.emails);
        if (outcome === 'sent') sent += 1;
        else if (outcome !== 'none') {
          this.logger?.info({ shopId, scheduleId: id, outcome }, 'scheduled export not sent');
        }
      } catch (error) {
        // One schedule's failure is not the others': its lease ends, and it is due again.
        this.logger?.warn({ err: error, shopId, scheduleId: id }, 'scheduled export failed');
      }
    }
    return sent;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'scheduled exports sweep failed'),
    );
  }
}

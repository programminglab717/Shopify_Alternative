import type {
  ExportRunOutcome,
  ExportScheduleService,
  ScheduledExportEmail,
} from '@hatti/orders/public';
import { ScheduledExportSender } from '@hatti/orders/public';
import { describe, expect, it } from 'vitest';
import { ScheduledExports } from './scheduled-exports.js';

class NoEmails extends ScheduledExportSender {
  async send(_email: ScheduledExportEmail): Promise<'sent'> {
    return 'sent';
  }
}

describe('Scheduled exports in the worker (ADR-183)', () => {
  it('runs each schedule due, counts those sent, and goes on past one that fails', async () => {
    const ran: string[] = [];
    const outcomes: Record<string, ExportRunOutcome | Error> = {
      a: 'sent',
      b: new Error('connection lost'),
      c: 'skipped',
      d: 'sent',
    };
    const schedules = {
      due: async () => Object.keys(outcomes).map((id) => ({ shopId: 'shop', id })),
      run: async (_shopId: string, id: string) => {
        ran.push(id);
        const outcome = outcomes[id]!;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as unknown as ExportScheduleService;
    const logged: unknown[] = [];
    const logger = {
      info: (fields: unknown) => void logged.push(['info', fields]),
      warn: (fields: unknown) => void logged.push(['warn', fields]),
    };
    const sweep = new ScheduledExports(schedules, new NoEmails(), logger as never);
    expect(await sweep.sweep(new Date('2026-10-05T03:00:00Z'))).toBe(2);
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
    expect(logged).toEqual([
      ['warn', expect.objectContaining({ scheduleId: 'b' })],
      ['info', { shopId: 'shop', scheduleId: 'c', outcome: 'skipped' }],
    ]);
  });
});

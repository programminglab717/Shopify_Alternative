import type { MessageRetention, PurgedCounts } from '@hatti/messaging/public';
import { describe, expect, it, vi } from 'vitest';
import { MessageContentRetention } from './message-retention.js';

const NONE: PurgedCounts = {
  messages: 0,
  conversationMessages: 0,
  conversations: 0,
  contactMessages: 0,
};

describe('Message content purged by the worker after twelve months (ADR-738)', () => {
  it('purges a batch at a time until one comes back short, at the time asked, logging what went and what failed', async () => {
    type Failed = (shopId: string, error: unknown) => void;
    const purge = vi.fn<(at?: Date, limit?: number, failed?: Failed) => Promise<PurgedCounts>>();
    const trouble = new Error('statement timeout');
    purge
      .mockImplementationOnce(async (_at, _limit, failed) => {
        failed!('0190a1b2-0000-7000-8000-000000000001', trouble);
        return { messages: 1_000, conversationMessages: 20, conversations: 2, contactMessages: 3 };
      })
      .mockResolvedValueOnce({ ...NONE, messages: 400 });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new MessageContentRetention(
      { purge } as unknown as MessageRetention,
      logger as never,
    );
    const at = new Date('2027-03-01T09:00:00Z');

    expect(await sweeps.sweep(at)).toEqual({
      messages: 1_400,
      conversationMessages: 20,
      conversations: 2,
      contactMessages: 3,
    });
    expect(purge).toHaveBeenCalledTimes(2);
    expect(purge.mock.calls.map(([when, limit]) => [when, limit])).toEqual([
      [at, 1_000],
      [at, 1_000],
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: trouble, shopId: '0190a1b2-0000-7000-8000-000000000001' },
      'message content not purged',
    );
    expect(logger.info).toHaveBeenCalledWith(
      { messages: 1_400, conversationMessages: 20, conversations: 2, contactMessages: 3 },
      'message content past twelve months purged',
    );
  });

  it('logs nothing when nothing was old enough', async () => {
    const purge = vi.fn().mockResolvedValue(NONE);
    const logger = { info: vi.fn(), warn: vi.fn() };
    await new MessageContentRetention(
      { purge } as unknown as MessageRetention,
      logger as never,
    ).sweep();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { createLogger } from '@hatti/logger';
import { LocalStorage } from '@hatti/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErasedReceipts } from './erased-receipts.js';
import { eventHandlers } from './start-worker.js';

describe("Erased receipts' files", () => {
  let directory: string;
  let storage: LocalStorage;
  const shopId = newId();
  const orderId = newId();
  const receipt = (order: string, id = newId()) => `shops/${shopId}/receipts/${order}/${id}.jpg`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hatti-erased-receipts-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost/storage',
      secret: 'x'.repeat(32),
    });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("are removed once the erasure's event reaches the worker, and only the order's", async () => {
    const [first, second] = [receipt(orderId), receipt(orderId)];
    const others = [receipt(newId()), `shops/${newId()}/receipts/${orderId}/${newId()}.jpg`];
    for (const key of [first, second, ...others]) {
      await storage.put(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    }
    const logger = createLogger({ name: 'worker', level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    const handlers = eventHandlers(logger, { receipts: new ErasedReceipts(storage, logger) });
    const event: DomainEvent = {
      id: newId(),
      type: 'order.receipts_erased',
      shopId,
      aggregateType: 'order',
      aggregateId: orderId,
      // A key of another order, or another shop, is not this event's to remove.
      payload: { keys: [first, second, ...others] },
      occurredAt: new Date().toISOString(),
    };

    await handlers.dispatch(event);
    expect(await storage.head(first)).toBeNull();
    expect(await storage.head(second)).toBeNull();
    for (const key of others) expect(await storage.head(key)).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);

    // Handled again, as a queue may: nothing left to remove, and no error.
    await handlers.dispatch(event);
    expect(await storage.head(first)).toBeNull();
  });
});

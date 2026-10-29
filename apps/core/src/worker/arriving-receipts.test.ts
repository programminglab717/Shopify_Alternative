import type { MutationResult, TenantContext } from '@hatti/api';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import type { ReceiptReadingService } from '@hatti/orders/public';
import { describe, expect, it } from 'vitest';
import { ArrivingReceipts } from './arriving-receipts.js';

/** An order's update, as the worker hears it. */
function updated(changed: string[], shopId = newId(), orderId = newId()): DomainEvent {
  return {
    id: newId(),
    type: 'order.updated',
    shopId,
    aggregateType: 'order',
    aggregateId: orderId,
    occurredAt: '2026-10-29T10:00:00.000Z',
    payload: { changed, stage: 'awaiting_payment', version: 2 },
  };
}

describe('Receipts read as they arrive (PAY-08, ADR-915)', () => {
  it("reads each of an order's unread receipts as one arrives, as the shop's own app", async () => {
    const asked: { shopId: string; orderId: string }[] = [];
    const read: { tenant: TenantContext; id: string }[] = [];
    const readings: Pick<ReceiptReadingService, 'arrivedUnread' | 'read'> = {
      arrivedUnread: (shopId, orderId) => {
        asked.push({ shopId, orderId });
        return Promise.resolve(['r1', 'r2']);
      },
      read: (tenant, id) => {
        read.push({ tenant, id });
        // The shop's credits run out after the first.
        return Promise.resolve(
          (id === 'r1'
            ? { ok: true, value: { outcome: 'not_a_receipt', readAt: new Date() } }
            : {
                ok: false,
                errors: [{ field: ['base'], code: 'TOO_MANY', message: 'No credits left' }],
              }) as MutationResult<never>,
        );
      },
    };
    const arriving = new ArrivingReceipts(readings);
    const event = updated(['transferReceipt']);
    expect(await arriving.handle(event)).toBe(1);
    expect(asked).toEqual([{ shopId: event.shopId, orderId: event.aggregateId }]);
    expect(read.map((each) => each.id)).toEqual(['r1', 'r2']);
    expect(read[0]!.tenant).toMatchObject({ shopId: event.shopId, actor: { kind: 'app' } });

    // Any other change to an order reads nothing.
    expect(await arriving.handle(updated(['note']))).toBe(0);
    expect(asked).toHaveLength(1);
  });
});

import type { Logger } from '@hatti/logger';
import type { DomainEvent } from '@hatti/events';
import {
  OrderEvents,
  type OrderUpdatedPayload,
  type ReceiptReadingService,
} from '@hatti/orders/public';

/** The shop as the worker reads its receipts: an app of Hatti's own. */
const WORKER = { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' } as const;

/**
 * Receipts read as they arrive (PAY-08, ADR-915): as a customer sends a receipt for their
 * transfer, a shop that has them read so has the AI read each one not yet read, as staff asking
 * would, spending a credit each. Without credits, a receipt stays unread for staff to ask later;
 * one the AI couldn't read is kept so, for them to ask again.
 */
export class ArrivingReceipts {
  /** The events {@link handle} reads: an order's receipt arriving changes the order. */
  static readonly EVENTS: readonly string[] = [OrderEvents.OrderUpdated];

  constructor(
    private readonly readings: Pick<ReceiptReadingService, 'arrivedUnread' | 'read'>,
    private readonly logger?: Logger,
  ) {}

  /** How many of the order's receipts were read. */
  async handle(event: DomainEvent, now: Date = new Date()): Promise<number> {
    const payload = event.payload as Partial<OrderUpdatedPayload>;
    if (!payload.changed?.includes('transferReceipt')) return 0;
    let read = 0;
    for (const id of await this.readings.arrivedUnread(event.shopId, event.aggregateId)) {
      const result = await this.readings.read(
        { shopId: event.shopId, currency: 'PKR', actor: WORKER, scopes: new Set() },
        id,
        now,
      );
      if (result.ok) read += 1;
      else {
        this.logger?.info(
          { shopId: event.shopId, receiptId: id, code: result.errors[0]?.code },
          'receipt not read as it arrived',
        );
      }
    }
    return read;
  }
}

import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import { OrderEvents, type OrderReceiptsErasedPayload } from '@hatti/orders/public';
import type { ObjectStorage } from '@hatti/storage';

/**
 * Removes from storage the files of the receipts that went with their customer's erasure
 * (ADR-113), once the erasure has committed: the keys its order's event names, each under that
 * order's receipts. Removing a file already gone changes nothing, so an event handled twice, or
 * late, does no harm.
 */
export class ErasedReceipts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OrderEvents.OrderReceiptsErased];

  constructor(
    private readonly storage: Pick<ObjectStorage, 'delete'>,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { keys } = event.payload as Partial<OrderReceiptsErasedPayload>;
    const prefix = `shops/${event.shopId}/receipts/${event.aggregateId}/`;
    for (const key of keys ?? []) {
      // The order's own receipts alone, whatever an event says.
      if (!key.startsWith(prefix)) {
        this.logger?.warn({ eventId: event.id, key }, 'not a receipt of the order: left as it is');
        continue;
      }
      await this.storage.delete(key);
    }
  }
}

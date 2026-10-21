import { CustomerEvents } from '@hatti/customers/public';
import type { DomainEvent } from '@hatti/events';
import { OrderEvents, type FulfillmentUpdatedPayload } from '@hatti/orders/public';

/** What the handler needs of the orders module. */
export interface RiskRescorer {
  rescoreRisk(shopId: string, about: { customerId: string } | { orderId: string }): Promise<number>;
  holdForRefusal(shopId: string, orderId: string): Promise<number>;
}

/**
 * Scores a customer's orders still waiting to be confirmed again when their history changes
 * (COD-06, ADR-112): a parcel of theirs delivered, refused, back or lost, an order of theirs
 * cancelled, or another customer merged into them. Scoring again reads the history as it is, so
 * an event handled twice, or late, changes nothing more. A parcel turning back holds their orders
 * confirmed and yet to ship too, where the shop says so (COD-07, ADR-674); held, they are not
 * held again.
 */
export class RiskRescoring {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.FulfillmentUpdated,
    OrderEvents.OrderCancelled,
    CustomerEvents.CustomerMerged,
  ];

  constructor(private readonly orders: RiskRescorer) {}

  async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case OrderEvents.FulfillmentUpdated: {
        // A parcel's charges, claims and tracking say nothing of the customer.
        const { orderId, changed, status } = event.payload as Partial<FulfillmentUpdatedPayload>;
        if (orderId && changed?.includes('status')) {
          await this.orders.rescoreRisk(event.shopId, { orderId });
          if (status === 'returning') await this.orders.holdForRefusal(event.shopId, orderId);
        }
        return;
      }
      case OrderEvents.OrderCancelled:
        await this.orders.rescoreRisk(event.shopId, { orderId: event.aggregateId });
        return;
      case CustomerEvents.CustomerMerged:
        await this.orders.rescoreRisk(event.shopId, { customerId: event.aggregateId });
        return;
    }
  }
}

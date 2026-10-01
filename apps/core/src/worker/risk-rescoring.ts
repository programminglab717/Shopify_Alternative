import { CustomerEvents } from '@hatti/customers/public';
import type { DomainEvent } from '@hatti/events';
import { OrderEvents, type FulfillmentUpdatedPayload } from '@hatti/orders/public';

/** What the handler needs of the orders module. */
export interface RiskRescorer {
  rescoreRisk(shopId: string, about: { customerId: string } | { orderId: string }): Promise<number>;
}

/**
 * Scores a customer's orders still waiting to be confirmed again when their history changes
 * (COD-06, ADR-112): a parcel of theirs delivered, refused, back or lost, an order of theirs
 * cancelled, or another customer merged into them. Scoring again reads the history as it is, so
 * an event handled twice, or late, changes nothing more.
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
        const { orderId, changed } = event.payload as Partial<FulfillmentUpdatedPayload>;
        if (orderId && changed?.includes('status')) {
          await this.orders.rescoreRisk(event.shopId, { orderId });
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

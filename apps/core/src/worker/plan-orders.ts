import { shopProfile } from '@hatti/api';
import {
  BillingEvents,
  PLANS,
  type PlanCode,
  type SubscriptionChangedPayload,
} from '@hatti/billing/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import {
  OrderEvents,
  type OrderService,
  type PlanOrdersCountedPayload,
} from '@hatti/orders/public';
import { tellShop } from './shop-notices.js';

/**
 * A shop's orders a month on a plan that limits them (BIL-01, ADR-263), as the worker hears of
 * them. Tells the shop as its month's orders come near the limit and as they reach it, at its
 * alerts number and its owner's email, as Hatti's notices of its bills go (ADR-169): once a month
 * each, and at Hatti's cost. And frees every order of the shop past its limit once it is on a
 * plan that sets none.
 */
export class PlanOrders {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.PlanOrdersCounted,
    BillingEvents.SubscriptionChanged,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly orders: OrderService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { shopId } = event;
    switch (event.type) {
      case OrderEvents.PlanOrdersCounted: {
        const { month, placed, limit, plan } = event.payload as Partial<PlanOrdersCountedPayload>;
        if (!month || !placed || !limit || !plan) return;
        const kind = placed < limit ? 'orders_limit_near' : 'orders_limit_reached';
        await this.database.tenant(shopId, async (tx) => {
          const shop = await shopProfile(tx, shopId);
          await tellShop(tx, this.messages, shopId, {
            kind,
            // Once a month each, though cancelled orders bring the shop back to it.
            dedupeKey: `${kind}:${month}`,
            variables: { shop: shop.name, orders: String(placed), limit: String(limit), plan },
          });
        });
        return;
      }
      case BillingEvents.SubscriptionChanged: {
        const { plan } = event.payload as Partial<SubscriptionChangedPayload>;
        // A plan that limits orders frees none: its own orders past the limit stay so.
        if (!plan || PLANS[plan as PlanCode]?.ordersPerMonth !== null) return;
        await this.orders.releaseOverLimit(shopId);
        return;
      }
    }
  }
}

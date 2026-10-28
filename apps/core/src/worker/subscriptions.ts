import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import { OrderEvents, type SubscriptionService } from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Makes the subscriptions of orders placed with lines subscribed on the shop's selling plans
 * (CAT-16, ADR-862), as the worker hears of them; and cancels those of an order cancelled before
 * any other of theirs was placed.
 */
export class SubscriptionOrders {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    OrderEvents.OrderCancelled,
  ];

  constructor(
    private readonly subscriptions: Pick<
      SubscriptionService,
      'createFromOrder' | 'cancelWithOrder'
    >,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === OrderEvents.OrderCreated) {
      await this.subscriptions.createFromOrder(event.shopId, event.aggregateId);
    } else {
      await this.subscriptions.cancelWithOrder(event.shopId, event.aggregateId);
    }
  }
}

/**
 * Places the orders of the subscriptions due (ADR-862), each sweep: across shops, one's failure not
 * the others'. What went wrong unexpectedly is logged.
 */
export class SubscriptionSweeps {
  constructor(
    private readonly subscriptions: Pick<SubscriptionService, 'placeDue' | 'errors'>,
    private readonly logger?: Logger,
  ) {}

  async sweep(at: Date = new Date()): Promise<{ placed: number; failed: number }> {
    const done = await this.subscriptions.placeDue(at);
    for (const error of this.subscriptions.errors.splice(0)) {
      this.logger?.warn({ err: error }, "subscription's order not placed");
    }
    if (done.placed + done.failed > 0) this.logger?.info(done, "subscriptions' orders placed");
    return done;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'subscriptions sweep failed'),
    );
  }
}

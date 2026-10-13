import {
  WEBHOOK_EVENTS,
  type WebhookSender,
  type WebhookService,
  type WebhookSweep,
} from '@hatti/apps/public';
import type { DomainEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Turns the shop's events into webhook deliveries (DEV-03, ADR-397): one for each app's
 * subscription to a topic the event makes, once however often the event comes.
 */
export class WebhookFanOut {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = WEBHOOK_EVENTS;

  constructor(private readonly webhooks: WebhookService) {}

  async handle(event: DomainEvent): Promise<void> {
    await this.webhooks.fanOut(event);
  }
}

/**
 * Posts the webhook deliveries due (ADR-397), signed with each app's secret; a failed one is tried
 * again later, for two days. A sweep that fails is logged, and the next tries again.
 */
export class WebhookDeliveries {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly sender: WebhookSender,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: what it delivered, will try again, and gave up on. */
  async sweep(at: Date = new Date()): Promise<WebhookSweep> {
    const done = await this.webhooks.deliverDue(this.sender, at);
    if (done.delivered + done.retrying + done.failed > 0) {
      this.logger?.info(done, 'webhooks posted');
    }
    return done;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'webhook deliveries sweep failed'),
    );
  }
}

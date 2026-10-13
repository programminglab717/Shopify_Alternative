import { PublicSite, shopProfile } from '@hatti/api';
import { reviewSettingsIn } from '@hatti/catalog/public';
import type { Database, Tx } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import type { MessagesService } from '@hatti/messaging/public';
import {
  ORDER_LINK_PATH,
  markReviewRequestedIn,
  messageLinkIn,
  reviewRequestsDueIn,
  shopsAskingForReviewsIn,
} from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Asks the customers of delivered orders to rate what they bought (MKT-05, ADR-400): once an
 * order, on WhatsApp, as many days after its last parcel arrived as the shop says, with the
 * order's page, where they rate it; the link its messages carried, while it works. An order
 * rated before it is asked about is not. Each shop in its own transaction: one that fails is
 * logged and tried again on the next sweep.
 */
export class ReviewRequests {
  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    /** Where customers' order pages are. */
    private readonly site: PublicSite,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many customers it asked. */
  async sweep(at: Date = new Date()): Promise<number> {
    const shops = await this.database.system((tx) => shopsAskingForReviewsIn(tx, at));
    let asked = 0;
    for (const shopId of shops) {
      try {
        asked += await this.database.tenant(shopId, (tx) => this.#askIn(tx, shopId, at));
      } catch (error) {
        this.logger?.warn({ err: error, shopId }, 'review requests not sent');
      }
    }
    if (asked > 0) this.logger?.info({ asked }, 'customers asked to rate their orders');
    return asked;
  }

  async #askIn(tx: Tx, shopId: string, at: Date): Promise<number> {
    const { requestAfterDays } = await reviewSettingsIn(tx, shopId);
    if (requestAfterDays === null) return 0;
    const due = await reviewRequestsDueIn(tx, shopId, at, requestAfterDays);
    if (due.length === 0) return 0;
    const shop = (await shopProfile(tx, shopId)).name;
    const pages = this.site.url(`/${ORDER_LINK_PATH}/`);
    let asked = 0;
    for (const order of due) {
      const known = (await this.messages.linksIn(tx, shopId, order.orderId))
        .filter((url) => url.startsWith(pages))
        .map((url) => url.slice(pages.length));
      const path = await messageLinkIn(
        tx,
        shopId,
        order.orderId,
        'with the message asking them to rate what it brought',
        known,
        { ended: true },
      );
      if (path) {
        const id = await this.messages.queueIn(tx, shopId, {
          kind: 'review_request',
          recipient: order.phone,
          orderId: order.orderId,
          customerId: order.customerId,
          dedupeKey: `review_request:${order.orderId}`,
          variables: {
            name: order.customerName?.trim().split(/\s+/)[0] ?? '',
            order: order.name,
            shop,
            url: this.site.url(path),
          },
        });
        if (id) asked += 1;
      }
      // Asked, or with no page to ask them to: either way, not again.
      await markReviewRequestedIn(tx, shopId, order.orderId, at);
    }
    return asked;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'review requests sweep failed'),
    );
  }
}

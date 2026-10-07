import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import { OnlineStoreEvents, type DomainUnpointedPayload } from '@hatti/online-store/public';
import { shopTime } from './notifications.js';
import { tellShop } from './shop-notices.js';

/**
 * Tells a shop that DNS points a domain of its own elsewhere (ADR-262), as the online store's
 * `domain.unpointed` is heard: the domain, and when it is disconnected unless DNS points it back
 * before, in the shop's time zone. At its alerts number and its owner's email, as Hatti's notices
 * of its bills go (ADR-169): once, and at Hatti's cost.
 */
export class DomainNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OnlineStoreEvents.DomainUnpointed];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    if (event.type !== OnlineStoreEvents.DomainUnpointed) return;
    const { host, disconnectAt } = event.payload as Partial<DomainUnpointedPayload>;
    if (!host || !disconnectAt) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const shop = await shopProfile(tx, shopId);
      await tellShop(tx, this.messages, shopId, {
        kind: 'domain_unpointed',
        dedupeKey: `domain_unpointed:${event.id}`,
        variables: {
          shop: shop.name,
          domain: host,
          date: shopTime(shop.timezone, new Date(disconnectAt)),
        },
      });
    });
  }
}

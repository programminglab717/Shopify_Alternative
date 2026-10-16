import { shopProfile, type StorefrontSite, type TenantContext } from '@hatti/api';
import type { SegmentService } from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import {
  OnlineStoreEvents,
  shopPreferencesOf,
  type PreferencesUpdatedPayload,
} from '@hatti/online-store/public';

/** The tag the closed shop's page gives those who ask to hear when it opens (ADR-446). */
export const WAITLIST_TAG = 'waitlist';

/** Those on the waitlist who still agree to hear from the shop on WhatsApp. */
const WAITING = `customer_tags CONTAINS '${WAITLIST_TAG}' AND whatsapp_subscription_status = subscribed`;

/** How many of them are read at a time. */
const PAGE = 200;

/** The shop as the worker reads its customers: only its ID is read. */
function workerTenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    scopes: new Set(),
  };
}

/**
 * The pre-launch waitlist (ONB-14, ADR-446): once a shop takes its password away and opens, each
 * shopper who asked on its closed page to hear when it does, and still agrees to hear from it on
 * WhatsApp, is told so once, from Hatti's number, with the shop's link. Closing and opening again
 * tells nobody twice.
 */
export class StoreOpenNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OnlineStoreEvents.PreferencesUpdated];

  constructor(
    private readonly database: Database,
    private readonly segments: Pick<SegmentService, 'members'>,
    private readonly messages: Pick<MessagesService, 'queueIn'>,
    private readonly storefronts: StorefrontSite,
  ) {}

  /** How many shoppers it told. */
  async handle(event: DomainEvent): Promise<number> {
    const changed = (event.payload as Partial<PreferencesUpdatedPayload>).changed ?? [];
    if (!changed.includes('passwordEnabled')) return 0;
    const { shopId } = event;
    const shop = await this.database.tenant(shopId, async (tx) => {
      if ((await shopPreferencesOf(tx, shopId)).passwordEnabled) return null;
      const profile = await shopProfile(tx, shopId);
      return { name: profile.name, url: this.storefronts.url(profile.handle) };
    });
    if (!shop) return 0;
    let told = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.segments.members(workerTenant(shopId), WAITING, {
        first: PAGE,
        after,
      });
      await this.database.tenant(shopId, async (tx) => {
        for (const customer of page.items) {
          const id = await this.messages.queueIn(tx, shopId, {
            kind: 'store_open',
            recipient: customer.phone,
            customerId: customer.id,
            // Once a customer, whenever the shop opens.
            dedupeKey: `store_open:${customer.id}`,
            variables: { shop: shop.name, url: shop.url },
            channel: 'whatsapp',
          });
          if (id) told += 1;
        }
      });
      if (!page.hasNextPage || page.items.length === 0) return told;
      after = page.items.at(-1)!.id;
    }
  }
}

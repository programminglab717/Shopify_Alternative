import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { FileEvents, type StoreExportPayload } from '@hatti/files/public';
import { ownerEmailIn } from '@hatti/identity/public';
import type { MessagesService } from '@hatti/messaging/public';
import { shopTime } from './notifications.js';

/**
 * Tells the shop's owner that the whole store's export they asked for is ready (ADM-10,
 * ADR-417), as the files module's `store_export.ready` is heard: by email alone, at the address
 * their account proved, in their own language, and until when it downloads. Never to the shop's
 * alerts number, which others may read: the export is the owner's. Once, and at Hatti's cost.
 */
export class StoreExportNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [FileEvents.StoreExportReady];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    if (event.type !== FileEvents.StoreExportReady) return;
    const { expiresAt } = event.payload as Partial<StoreExportPayload>;
    if (!expiresAt) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      // Through identity's function for the shop of the transaction, never its tables (ADR-193).
      const owner = await ownerEmailIn(tx, shopId);
      if (!owner) return;
      const shop = await shopProfile(tx, shopId);
      await this.messages.queueIn(tx, shopId, {
        kind: 'store_export_ready',
        recipient: owner.email,
        language: owner.language,
        dedupeKey: `store_export_ready:${event.aggregateId}`,
        variables: { shop: shop.name, date: shopTime(shop.timezone, new Date(expiresAt)) },
        channel: 'email',
      });
    });
  }
}

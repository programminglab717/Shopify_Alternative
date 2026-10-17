import { shopProfile } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  InventoryEvents,
  type InventoryLevelUpdatedPayload,
  type LowStockService,
} from '@hatti/inventory/public';
import { settingsIn, type MessagesService, type PushService } from '@hatti/messaging/public';
import { lowStockNotice, type PushNotice } from './push-notices.js';

/**
 * Tells the shop on WhatsApp when a variant runs low on stock, and when it runs out (INV-01,
 * ADR-157), as each change of its levels is heard: at the shop's alerts number, once a spell of
 * low stock, which lasts until the variant is stocked above the shop's threshold again. Nothing
 * while the shop gives no number, or turned the alert off. And pushes it to the browsers of its
 * owners and managers who asked for it (ADR-506), whatever the number, once each time too.
 */
export class LowStockAlerts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [InventoryEvents.InventoryLevelUpdated];

  constructor(
    private readonly database: Database,
    private readonly lowStock: LowStockService,
    private readonly messages: MessagesService,
    private readonly push: PushService | null = null,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { inventoryItemId } = event.payload as Partial<InventoryLevelUpdatedPayload>;
    if (!inventoryItemId) return;
    const { shopId } = event;
    const notice = await this.database.tenant(shopId, async (tx): Promise<PushNotice | null> => {
      const alert = await this.lowStock.alertIn(tx, shopId, inventoryItemId);
      if (!alert) return null;
      const product =
        alert.variantTitle === DEFAULT_VARIANT_TITLE
          ? alert.productTitle
          : `${alert.productTitle} (${alert.variantTitle})`;
      const { alertsPhone } = await settingsIn(tx, shopId);
      if (alertsPhone) {
        await this.messages.queueIn(tx, shopId, {
          kind: alert.state === 'out' ? 'stock_out' : 'stock_low',
          recipient: alertsPhone,
          // Once a spell, and once more when it runs out.
          dedupeKey: `stock_${alert.state}:${alert.variantId}:${alert.since.getTime()}`,
          variables: {
            shop: (await shopProfile(tx, shopId)).name,
            product,
            stock: String(alert.available),
          },
          channel: 'whatsapp',
        });
      }
      return this.push?.publicKey ? lowStockNotice(tx, shopId, alert, product) : null;
    });
    // After the spell is kept: a push that fails is not tried again, as the alert is not.
    if (notice) {
      await this.push!.push(
        shopId,
        notice.kind,
        notice.dedupeKey,
        notice.recipients,
        notice.message,
      );
    }
  }
}

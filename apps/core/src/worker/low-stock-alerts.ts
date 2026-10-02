import { shopProfile } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  InventoryEvents,
  type InventoryLevelUpdatedPayload,
  type LowStockService,
} from '@hatti/inventory/public';
import { settingsIn, type MessagesService } from '@hatti/messaging/public';

/**
 * Tells the shop on WhatsApp when a variant runs low on stock, and when it runs out (INV-01,
 * ADR-157), as each change of its levels is heard: at the shop's alerts number, once a spell of
 * low stock, which lasts until the variant is stocked above the shop's threshold again. Nothing
 * while the shop gives no number, or turned the alert off.
 */
export class LowStockAlerts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [InventoryEvents.InventoryLevelUpdated];

  constructor(
    private readonly database: Database,
    private readonly lowStock: LowStockService,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { inventoryItemId } = event.payload as Partial<InventoryLevelUpdatedPayload>;
    if (!inventoryItemId) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const alert = await this.lowStock.alertIn(tx, shopId, inventoryItemId);
      if (!alert) return;
      const { alertsPhone } = await settingsIn(tx, shopId);
      if (!alertsPhone) return;
      const product =
        alert.variantTitle === DEFAULT_VARIANT_TITLE
          ? alert.productTitle
          : `${alert.productTitle} (${alert.variantTitle})`;
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
    });
  }
}

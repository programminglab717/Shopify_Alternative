import { shopProfile, type PublicSite } from '@hatti/api';
import {
  DOWNLOAD_LINK_PATH,
  deliverDigitalIn,
  digitalIn,
  issueLicenceKeyIn,
} from '@hatti/catalog/public';
import type { SecretBox } from '@hatti/crypto';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import { OrderEvents, orderGiftCardFactsIn } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';

/**
 * Delivers the digital products an order sold (CAT-13, ADR-814), as its payment is heard: once it
 * is paid in full and not cancelled, each of its lines of a digital product with files is given a
 * link of its own to them, sent to its customer on WhatsApp; and each unit of one that gives
 * licence keys is given a key, sent the same way, kept nowhere in the message once sent. Each is
 * given once, however often its order's payment is heard. A unit sold when none of its product's
 * keys are left is given none: the shop sends it once it adds more (ADR-816).
 */
export class DigitalSales {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OrderEvents.OrderPaid];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly site: PublicSite,
    /** Opens licence keys; without it, none are given. */
    private readonly box: SecretBox | null,
  ) {}

  async handle(event: DomainEvent, at: Date = new Date()): Promise<void> {
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderGiftCardFactsIn(tx, shopId, event.aggregateId);
      if (!order || order.status === 'cancelled' || order.amountPaid < order.total) return;
      const digital = await digitalIn(
        tx,
        shopId,
        order.lines.map((line) => line.productId),
      );
      const lines = order.lines.filter((line) => digital.has(line.productId));
      if (lines.length === 0) return;
      const { name: shop } = await shopProfile(tx, shopId);
      const { rows: titles } = await tx.execute<{ id: string; title: string }>(
        sql`SELECT id, title FROM catalog.products
             WHERE shop_id = ${shopId}
               AND id = ANY(${sql.param(lines.map((line) => line.productId))}::uuid[])`,
      );
      const titleOf = (id: string) => titles.find((each) => each.id === id)?.title ?? '';
      for (const line of lines) {
        const product = digital.get(line.productId)!;
        const message = {
          recipient: order.phone ?? '',
          orderId: order.id,
          customerId: order.customerId,
        };
        if (product.files.some((file) => file.status === 'ready')) {
          const token = await deliverDigitalIn(
            tx,
            shopId,
            {
              orderId: order.id,
              lineItemId: line.id,
              productId: line.productId,
              units: line.quantity,
              downloadLimit: product.downloadLimit,
              linkDays: product.linkDays,
            },
            at,
          );
          // A customer erased has no number to send it to.
          if (token && order.phone) {
            const id = await this.messages.queueIn(tx, shopId, {
              ...message,
              kind: 'digital_download',
              dedupeKey: `digital_download:${line.id}`,
              variables: { shop, product: titleOf(line.productId) },
            });
            if (id) {
              await this.messages.linkIn(
                tx,
                shopId,
                id,
                this.site.url(`/${DOWNLOAD_LINK_PATH}/${token}`),
              );
            }
          }
        }
        if (!product.licenceKeys || !this.box) continue;
        for (let unit = 1; unit <= line.quantity; unit++) {
          const key = await issueLicenceKeyIn(
            tx,
            shopId,
            line.productId,
            { orderId: order.id, lineItemId: line.id, lineUnit: unit },
            this.box,
            at,
          );
          if (!key) break;
          if (!order.phone) continue;
          await this.messages.queueIn(tx, shopId, {
            ...message,
            kind: 'licence_key',
            dedupeKey: `licence_key:${line.id}:${unit}`,
            variables: { shop, product: titleOf(line.productId), code: key },
          });
        }
      }
    });
  }
}

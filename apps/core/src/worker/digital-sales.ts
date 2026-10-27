import { shopProfile, type PublicSite } from '@hatti/api';
import {
  DOWNLOAD_LINK_PATH,
  DigitalProductEvents,
  deliverDigitalIn,
  digitalIn,
  issueLicenceKeyIn,
  keysIssuedIn,
} from '@hatti/catalog/public';
import type { SecretBox } from '@hatti/crypto';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import {
  OrderEvents,
  orderGiftCardFactsIn,
  paidOrdersWithProductIn,
  type FulfillmentService,
} from '@hatti/orders/public';
import { sql } from 'drizzle-orm';

/**
 * Delivers the digital products an order sold (CAT-13, ADR-814), as its payment is heard: once it
 * is paid in full and not cancelled, each of its lines of a digital product with files is given a
 * link of its own to them, sent to its customer on WhatsApp; and each unit of one that gives
 * licence keys is given a key, sent the same way, kept nowhere in the message once sent. Each is
 * given once, however often its order's payment is heard. A unit sold when none of its product's
 * keys are left is given none until the shop adds more, when the paid orders waiting for them
 * are delivered again (ADR-816). A line given all it sells is fulfilled and delivered at once, as
 * no courier carries it (ADR-815).
 */
export class DigitalSales {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderPaid,
    DigitalProductEvents.KeysAdded,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly site: PublicSite,
    /** Opens licence keys; without it, none are given. */
    private readonly box: SecretBox | null,
    /** Fulfils the lines given all they sell; without it, they wait for the shop. */
    private readonly fulfillments: FulfillmentService | null = null,
  ) {}

  async handle(event: DomainEvent, at: Date = new Date()): Promise<void> {
    if (event.type !== DigitalProductEvents.KeysAdded) {
      await this.#deliver(event.shopId, event.aggregateId, at);
      return;
    }
    // Keys added: the paid orders with units of the product still owed one.
    const { shopId } = event;
    const waiting = await this.database.tenant(shopId, async (tx) => {
      const orders = await paidOrdersWithProductIn(tx, shopId, event.aggregateId);
      const given = await keysIssuedIn(
        tx,
        shopId,
        orders.flatMap((order) => order.lines.map((line) => line.id)),
      );
      return orders
        .filter((order) => order.lines.some((line) => (given.get(line.id) ?? 0) < line.quantity))
        .map((order) => order.orderId);
    });
    for (const orderId of waiting) await this.#deliver(shopId, orderId, at);
  }

  /** Delivers what order `orderId` sold of digital products and has not had: once paid. */
  async #deliver(shopId: string, orderId: string, at: Date): Promise<void> {
    const done = await this.database.tenant(shopId, async (tx) => {
      /** The lines given all they sell, to fulfil. */
      const given: { id: string; quantity: number }[] = [];
      const order = await orderGiftCardFactsIn(tx, shopId, orderId);
      if (!order || order.status === 'cancelled' || order.amountPaid < order.total) return null;
      const digital = await digitalIn(
        tx,
        shopId,
        order.lines.map((line) => line.productId),
      );
      const lines = order.lines.filter((line) => digital.has(line.productId));
      if (lines.length === 0) return null;
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
        let keys = 0;
        if (product.licenceKeys && this.box) {
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
            keys += 1;
            if (!order.phone) continue;
            await this.messages.queueIn(tx, shopId, {
              ...message,
              kind: 'licence_key',
              dedupeKey: `licence_key:${line.id}:${unit}`,
              variables: { shop, product: titleOf(line.productId), code: key },
            });
          }
        }
        // Given all it sells: its files, where it has any, and a key for each unit, where it
        // gives them.
        const files = product.files.some((file) => file.status === 'ready');
        const keyed = !product.licenceKeys || (this.box !== null && keys === line.quantity);
        if ((files || product.licenceKeys) && keyed) {
          given.push({ id: line.id, quantity: line.quantity });
        }
      }
      return { orderId: order.id, given };
    });
    if (!done || done.given.length === 0 || !this.fulfillments) return;
    // A line fulfilled already, as when the payment is heard again, is refused: nothing to do.
    const fulfilled = await this.fulfillments.fulfill({ shopId, actor: 'system' }, done.orderId, {
      lineItems: done.given,
    });
    if (fulfilled.ok) {
      await this.fulfillments.markDelivered(
        { shopId, actor: 'system' },
        fulfilled.value.fulfillmentId,
      );
    }
  }
}

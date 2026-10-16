import { shopProfile } from '@hatti/api';
import { giftCardProductIdsIn } from '@hatti/catalog/public';
import { formatGiftCardCode, issueSoldGiftCardsIn } from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { OrderEvents, orderGiftCardFactsIn } from '@hatti/orders/public';

/**
 * Issues the gift cards an order sold (CAT-12, ADR-451), as its payment is heard: once it is paid
 * in full and not cancelled, a card for each unit of a gift card product it holds, worth what the
 * unit sold for, given to its customer; and each card's code sent to them on WhatsApp, the one
 * time anyone sees it, as the message drops it once sent. Each unit's card is issued once, however
 * often its order's payment is heard.
 */
export class GiftCardSales {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OrderEvents.OrderPaid];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const order = await orderGiftCardFactsIn(tx, shopId, event.aggregateId);
      if (!order || order.status === 'cancelled' || order.amountPaid < order.total) return;
      const giftCards = await giftCardProductIdsIn(
        tx,
        shopId,
        order.lines.map((line) => line.productId),
      );
      const lines = order.lines.filter((line) => giftCards.has(line.productId));
      if (lines.length === 0) return;
      const { name: shop } = await shopProfile(tx, shopId);
      for (const line of lines) {
        const issued = await issueSoldGiftCardsIn(tx, shopId, {
          orderId: order.id,
          lineItemId: line.id,
          units: line.quantity,
          value: line.unitPrice,
          currency: order.currency,
          customerId: order.customerId,
          note: `Order #${order.number}`,
        });
        // A customer erased has no number to send it to: the shop can deactivate it.
        if (!order.phone) continue;
        for (const card of issued) {
          await this.messages.queueIn(tx, shopId, {
            kind: 'gift_card',
            recipient: order.phone,
            orderId: order.id,
            customerId: order.customerId,
            dedupeKey: `gift_card:${card.id}`,
            variables: {
              shop,
              amount: formatMoney(money(line.unitPrice, order.currency as CurrencyCode)),
              code: formatGiftCardCode(card.code),
            },
          });
        }
      }
    });
  }
}

import { shopProfile, type PublicSite } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { codPrepaidCreditIn, type MessagesService } from '@hatti/messaging/public';
import {
  ORDER_LINK_PATH,
  OrderEvents,
  messageLinkIn,
  offerPrepayIn,
  orderNotificationFactsIn,
  type OnlinePayments,
} from '@hatti/orders/public';

/**
 * COD to prepaid (MKT-04, ADR-432): as a cash-on-delivery order is confirmed, while the shop's
 * automation is on and it takes payments online, its customer is offered the store credit the
 * shop set for paying the rest online before it is packed: once an order, on WhatsApp from
 * Hatti's number, with the order's page, which takes the payment. The order keeps the offer; the
 * credit is given once it is paid in full online.
 */
export class CodPrepaidOffers {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [OrderEvents.OrderConfirmed];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
    private readonly payments: Pick<OnlinePayments, 'gatewaysOf'>,
    /** Where customers' order pages are. */
    private readonly site: PublicSite,
  ) {}

  /** Whether it offered the order's customer credit for paying online. */
  async handle(event: DomainEvent): Promise<boolean> {
    const { shopId, aggregateId: orderId } = event;
    return this.database.tenant(shopId, async (tx) => {
      const credit = await codPrepaidCreditIn(tx, shopId);
      if (credit === null) return false;
      const order = await orderNotificationFactsIn(tx, shopId, orderId);
      if (!order || order.erased || !order.phone || order.cashDue === 0n) return false;
      const currency = order.currency as CurrencyCode;
      if ((await this.payments.gatewaysOf(tx, shopId, currency)).length === 0) return false;
      const rest = await offerPrepayIn(tx, shopId, orderId, credit);
      if (rest === 0n) return false;
      const pages = this.site.url(`/${ORDER_LINK_PATH}/`);
      const known = (await this.messages.linksIn(tx, shopId, orderId))
        .filter((url) => url.startsWith(pages))
        .map((url) => url.slice(pages.length));
      const path = await messageLinkIn(
        tx,
        shopId,
        orderId,
        'with the offer of store credit for paying it online',
        known,
      );
      if (!path) return false;
      const rupees = (value: bigint) => formatMoney(money(value, currency));
      const id = await this.messages.queueIn(tx, shopId, {
        kind: 'cod_prepaid',
        recipient: order.phone,
        orderId,
        customerId: order.customerId,
        dedupeKey: `cod_prepaid:${orderId}`,
        variables: {
          name: order.name?.trim().split(/\s+/)[0] ?? '',
          order: `#${order.number}`,
          shop: (await shopProfile(tx, shopId)).name,
          amount: rupees(rest),
          credit: rupees(credit),
          url: this.site.url(path),
        },
      });
      return id !== null;
    });
  }
}

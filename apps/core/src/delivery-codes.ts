import { shopProfile } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { DeliveryCodeSender } from '@hatti/logistics/public';
import type { MessagesService } from '@hatti/messaging/public';

/**
 * Sends the codes customers give the shop's own riders at the door (ADR-824), as messages are
 * sent: queued in the caller's transaction, a code a parcel, kept nowhere once sent.
 */
export class MessagingDeliveryCodes extends DeliveryCodeSender {
  constructor(private readonly messages: MessagesService) {
    super();
  }

  async sendIn(
    tx: Tx,
    shopId: string,
    message: {
      phone: string;
      orderId: string;
      parcelId: string;
      order: string;
      rider: string;
      code: string;
    },
  ): Promise<boolean> {
    const { name: shop } = await shopProfile(tx, shopId);
    const id = await this.messages.queueIn(tx, shopId, {
      kind: 'delivery_code',
      recipient: message.phone,
      orderId: message.orderId,
      dedupeKey: `delivery_code:${message.parcelId}`,
      variables: { shop, order: message.order, rider: message.rider, code: message.code },
    });
    return id !== null;
  }
}

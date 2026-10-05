import { shopProfile } from '@hatti/api';
import {
  CustomerEvents,
  storeCreditNoticeFactsIn,
  type StoreCreditCreditedPayload,
  type StoreCreditExpiringPayload,
} from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import type { MessagesService } from '@hatti/messaging/public';
import { formatMoney, money } from '@hatti/money';
import { shopTime } from './notifications.js';

/**
 * Tells customers of their store credit (ORD-09, ADR-192), as its events are heard: credit given
 * them, by hand or as a refund, with what they have in all; and a credit of theirs with something
 * left, a week before it expires, with when. At their main number, on the shop's channel and in
 * its language, once each. Nothing for a customer gone, a credit spent or expired since, or what
 * the shop turned off.
 */
export class StoreCreditNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    CustomerEvents.StoreCreditCredited,
    CustomerEvents.StoreCreditExpiring,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const payload = event.payload as Partial<
      StoreCreditCreditedPayload & StoreCreditExpiringPayload
    >;
    const { transactionId } = payload;
    if (!transactionId) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      const credit = await storeCreditNoticeFactsIn(tx, shopId, event.aggregateId, transactionId);
      // Spent or expired since: nothing to spend, nothing to tell.
      if (!credit || credit.remaining <= 0n) return;
      const rupees = (paisa: bigint) => formatMoney(money(paisa, credit.currency));
      const { name: shop, timezone } = await shopProfile(tx, shopId);
      const to = { recipient: credit.phone, customerId: credit.customerId };
      if (event.type === CustomerEvents.StoreCreditCredited) {
        await this.messages.queueIn(tx, shopId, {
          kind: 'store_credit_given',
          ...to,
          dedupeKey: `store_credit_given:${transactionId}`,
          variables: {
            shop,
            amount: rupees(BigInt(payload.amount ?? credit.remaining.toString())),
            balance: rupees(credit.balance),
          },
        });
      } else if (event.type === CustomerEvents.StoreCreditExpiring && credit.expiresAt) {
        await this.messages.queueIn(tx, shopId, {
          kind: 'store_credit_expiring',
          ...to,
          dedupeKey: `store_credit_expiring:${transactionId}`,
          variables: {
            shop,
            amount: rupees(credit.remaining),
            date: shopTime(timezone, credit.expiresAt),
          },
        });
      }
    });
  }
}

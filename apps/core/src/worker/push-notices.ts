import { shopProfile } from '@hatti/api';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { staffPhonesIn } from '@hatti/identity/public';
import { toPublicId } from '@hatti/ids';
import type { LowStockAlert } from '@hatti/inventory/public';
import { LogisticsEvents, type CodRemittanceImportedPayload } from '@hatti/logistics/public';
import type { PushKind, PushMessage, PushRecipient, PushService } from '@hatti/messaging/public';
import { formatMoney, isCurrencyCode, money } from '@hatti/money';
import { OrderEvents, orderName, type OrderCreatedPayload } from '@hatti/orders/public';

/** What is pushed, to whom, once for its key. */
export interface PushNotice {
  kind: PushKind;
  dedupeKey: string;
  recipients: PushRecipient[];
  message: PushMessage;
}

/** Minor units as staff read them: "Rs 4,500". */
function amount(minor: string, currency: string): string {
  return formatMoney(money(BigInt(minor), isCurrencyCode(currency) ? currency : 'PKR'));
}

/** The shop's staff, to tell in their language, through identity's function (ADR-193). */
async function recipientsIn(tx: Tx, shopId: string): Promise<PushRecipient[]> {
  return (await staffPhonesIn(tx, shopId)).map(({ userId, role, language }) => ({
    userId,
    role,
    language,
  }));
}

/**
 * Pushes the shop's news to its staff's browsers (APP-03, ADR-506), as the events are heard: a
 * new order, or one held for review for its risk, to owners, managers and confirmation agents;
 * a courier's statement of cash remitted, to owners, managers and accountants. Each once, in each
 * member's language, opening its page in the admin. Low stock is pushed with the WhatsApp alert,
 * which keeps its spells ({@link lowStockNotice}). Nothing where Hatti has no VAPID keys.
 */
export class PushNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    LogisticsEvents.CodRemittanceImported,
  ];

  constructor(
    private readonly database: Database,
    private readonly push: PushService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    if (this.push.publicKey === null) return;
    const { shopId } = event;
    const notice = await this.database.tenant(shopId, async (tx) => {
      const shop = await shopProfile(tx, shopId);
      const recipients = await recipientsIn(tx, shopId);
      const base = `/${toPublicId('shop', shopId)}`;
      switch (event.type) {
        case OrderEvents.OrderCreated: {
          const order = event.payload as Partial<OrderCreatedPayload>;
          // A part split from an order is nothing new.
          if (order.splitFromId || order.number === undefined || order.total === undefined) {
            return null;
          }
          const name = orderName(order.number);
          const total = amount(order.total, order.currency ?? shop.currency);
          const url = `${base}/orders/${toPublicId('order', event.aggregateId)}`;
          if (order.stage === 'needs_review') {
            return {
              kind: 'needs_review',
              dedupeKey: `needs_review:${event.aggregateId}`,
              recipients,
              message: {
                en: {
                  title: `${shop.name}: order ${name} to review`,
                  body: `${total}, held for its risk. Look at it before it is confirmed.`,
                },
                ur: {
                  title: `${shop.name}: آرڈر ${name} جانچنا ہے`,
                  body: `${total}، رسک کی وجہ سے روکا گیا۔ کنفرم کرنے سے پہلے دیکھیں۔`,
                },
                url,
              },
            } satisfies PushNotice;
          }
          const cash = order.paymentMethod === 'cash_on_delivery';
          return {
            kind: 'new_order',
            dedupeKey: `new_order:${event.aggregateId}`,
            recipients,
            message: {
              en: {
                title: `${shop.name}: new order ${name}`,
                body: `${total}, ${cash ? 'cash on delivery' : 'paid ahead'}.`,
              },
              ur: {
                title: `${shop.name}: نیا آرڈر ${name}`,
                body: `${total}، ${cash ? 'کیش آن ڈیلیوری' : 'پہلے سے ادا شدہ'}۔`,
              },
              url,
            },
          } satisfies PushNotice;
        }
        case LogisticsEvents.CodRemittanceImported: {
          const statement = event.payload as Partial<CodRemittanceImportedPayload>;
          if (statement.received === undefined || !statement.courier) return null;
          const received = amount(statement.received, shop.currency);
          const parcels = statement.lineCount ?? 0;
          return {
            kind: 'cash_remitted',
            dedupeKey: `cash_remitted:${event.aggregateId}`,
            recipients,
            message: {
              en: {
                title: `${shop.name}: ${statement.courier} remitted ${received}`,
                body: `For ${parcels} ${parcels === 1 ? 'parcel' : 'parcels'}. Check it against what they owe.`,
              },
              ur: {
                title: `${shop.name}: ${statement.courier} نے ${received} بھیجے`,
                body: `${parcels} پارسلز کے لیے۔ واجب الادا رقم سے ملا کر دیکھیں۔`,
              },
              url: `${base}/cash/${toPublicId('codRemittance', event.aggregateId)}`,
            },
          } satisfies PushNotice;
        }
        default:
          return null;
      }
    });
    if (notice) {
      await this.push.push(
        shopId,
        notice.kind,
        notice.dedupeKey,
        notice.recipients,
        notice.message,
      );
    }
  }
}

/**
 * The push of a variant fallen to the shop's threshold, or run out (INV-01, ADR-506), to owners
 * and managers: once a spell, and once more when it runs out, as the WhatsApp alert is. In the
 * transaction its alert was found in.
 */
export async function lowStockNotice(
  tx: Tx,
  shopId: string,
  alert: LowStockAlert,
  product: string,
): Promise<PushNotice> {
  const shop = await shopProfile(tx, shopId);
  const out = alert.state === 'out';
  return {
    kind: 'low_stock',
    dedupeKey: `stock_${alert.state}:${alert.variantId}:${alert.since.getTime()}`,
    recipients: await recipientsIn(tx, shopId),
    message: {
      en: {
        title: `${shop.name}: ${product} ${out ? 'is out of stock' : 'is running low'}`,
        body: out
          ? 'None left for sale online. Restock it.'
          : `${alert.available} left for sale online. Restock it.`,
      },
      ur: {
        title: `${shop.name}: ${product} ${out ? 'کا اسٹاک ختم' : 'کا اسٹاک کم ہے'}`,
        body: out
          ? 'آن لائن فروخت کے لیے کچھ باقی نہیں۔ اسٹاک بڑھائیں۔'
          : `آن لائن فروخت کے لیے ${alert.available} باقی ہیں۔ اسٹاک بڑھائیں۔`,
      },
      url: `/${toPublicId('shop', shopId)}/products/${toPublicId('product', alert.productId)}`,
    },
  };
}

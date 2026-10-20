import { shopProfile } from '@hatti/api';
import type { Database, Tx } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import type { DomainEvent } from '@hatti/events';
import { staffPhonesIn } from '@hatti/identity/public';
import { toPublicId } from '@hatti/ids';
import type { LowStockAlert } from '@hatti/inventory/public';
import { LogisticsEvents, type CodRemittanceImportedPayload } from '@hatti/logistics/public';
import {
  MessagingEvents,
  type PushKind,
  type PushMessage,
  type PushRecipient,
  type PushService,
} from '@hatti/messaging/public';
import { formatMoney, isCurrencyCode, money } from '@hatti/money';
import { OnlineStoreEvents, type CommentChangedPayload } from '@hatti/online-store/public';
import {
  OrderEvents,
  orderName,
  overdueFirstCallsIn,
  type OrderCreatedPayload,
} from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

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

/**
 * The shop's staff, to tell in their language, with what they may do there (ADR-581), through
 * identity's function (ADR-193).
 */
async function recipientsIn(tx: Tx, shopId: string): Promise<PushRecipient[]> {
  return (await staffPhonesIn(tx, shopId)).map(
    ({ userId, role, language, scopes, capabilities }) => ({
      userId,
      role,
      language,
      scopes,
      capabilities,
    }),
  );
}

/**
 * Pushes the shop's news to its staff's browsers (APP-03, ADR-506), as the events are heard: a
 * new order, or one held for review for its risk, to owners, managers and confirmation agents;
 * a courier's statement of cash remitted, to owners, managers and accountants. Each once, in each
 * member's language, opening its page in the admin; a shopper's message through the contact form
 * (ADR-591), to those who answer customers, saying neither who wrote nor what, which push services
 * would carry; a comment held for the shop's approval (ADR-619), likewise, to those who write its
 * blogs, opening the article. Low stock is pushed with the WhatsApp alert, which keeps its spells
 * ({@link lowStockNotice}). Nothing where Hatti has no VAPID keys.
 */
export class PushNotices {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderCreated,
    LogisticsEvents.CodRemittanceImported,
    MessagingEvents.ContactMessageReceived,
    OnlineStoreEvents.CommentCreated,
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
        case MessagingEvents.ContactMessageReceived:
          return {
            kind: 'contact_message',
            dedupeKey: `contact_message:${event.aggregateId}`,
            recipients,
            message: {
              en: {
                title: `${shop.name}: a message from your contact page`,
                body: 'A shopper wrote to you. Read it in the inbox and answer them.',
              },
              ur: {
                title: `${shop.name}: رابطہ صفحے سے پیغام`,
                body: 'ایک خریدار نے آپ کو لکھا ہے۔ ان باکس میں پڑھیں اور جواب دیں۔',
              },
              url: `${base}/inbox?tab=form`,
            },
          } satisfies PushNotice;
        case OnlineStoreEvents.CommentCreated: {
          const comment = event.payload as Partial<CommentChangedPayload>;
          // Shown at once, or kept as spam: nothing waits.
          if (comment.status !== 'pending' || !comment.articleId) return null;
          return {
            kind: 'comment_pending',
            dedupeKey: `comment_pending:${event.aggregateId}`,
            recipients,
            message: {
              en: {
                title: `${shop.name}: a comment to approve`,
                body: 'A shopper commented on one of your articles. Approve it to show it.',
              },
              ur: {
                title: `${shop.name}: منظوری کے لیے تبصرہ`,
                body: 'ایک خریدار نے آپ کے ایک مضمون پر تبصرہ کیا ہے۔ دکھانے کے لیے منظور کریں۔',
              },
              url: `${base}/online-store/articles/${toPublicId('article', comment.articleId)}`,
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

/** How often the same shop is pushed of its overdue orders at most: an hour. */
export const OVERDUE_PUSH_EVERY_MS = 60 * 60_000;

/**
 * Pushes the shop's owners, managers and confirmation agents when orders have waited for their
 * first call longer than the shop's first-call target (COD-05, ADR-627), as the Confirmation
 * Desk counts them: at most once an hour while any wait, within its calling hours alone, opening
 * the desk. Nothing for a shop without a target, and nothing where Hatti has no VAPID keys. The
 * shops are found with the system role; each is read in its own transaction.
 */
export class OverdueOrderPushes {
  constructor(
    private readonly database: Database,
    private readonly push: PushService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many shops were pushed. */
  async sweep(at: Date = new Date()): Promise<number> {
    if (this.push.publicKey === null) return 0;
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM orders.order_settings WHERE first_call_minutes IS NOT NULL`),
    );
    let pushed = 0;
    for (const { shop_id: shopId } of shops) {
      try {
        const notice = await this.database.tenant(shopId, (tx) =>
          overdueOrdersNotice(tx, shopId, at),
        );
        if (!notice) continue;
        await this.push.push(
          shopId,
          notice.kind,
          notice.dedupeKey,
          notice.recipients,
          notice.message,
        );
        pushed += 1;
      } catch (error) {
        // One shop's failure is not the others': it is pushed on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'overdue orders not pushed');
      }
    }
    return pushed;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'overdue orders sweep failed'),
    );
  }
}

/**
 * The push of a shop's orders overdue for their first call at `at` (ADR-627), once in each hour:
 * null while none are, or outside its calling hours, when no one could call them.
 */
export async function overdueOrdersNotice(
  tx: Tx,
  shopId: string,
  at: Date,
): Promise<PushNotice | null> {
  const { count, callingNow } = await overdueFirstCallsIn(tx, shopId, at);
  if (count === 0 || !callingNow) return null;
  const shop = await shopProfile(tx, shopId);
  const hour = Math.floor(at.getTime() / OVERDUE_PUSH_EVERY_MS);
  return {
    kind: 'orders_overdue',
    dedupeKey: `orders_overdue:${hour}`,
    recipients: await recipientsIn(tx, shopId),
    message: {
      en: {
        title: `${shop.name}: ${count} ${count === 1 ? 'order' : 'orders'} not called in time`,
        body: 'Waiting for their first call longer than your target. Call them from the desk.',
      },
      ur: {
        title: `${shop.name}: ${count} ${count === 1 ? 'آرڈر' : 'آرڈرز'} کو وقت پر کال نہیں ہوئی`,
        body: 'آپ کے ہدف سے زیادہ دیر سے پہلی کال کے منتظر ہیں۔ ڈیسک سے کال کریں۔',
      },
      url: `/${toPublicId('shop', shopId)}/desk`,
    },
  };
}

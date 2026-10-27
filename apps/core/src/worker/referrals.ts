import { createHash } from 'node:crypto';
import { creditStoreCreditIn } from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  recordReferralIn,
  referralProgramIn,
  referralRecordedIn,
  referralsRewardedIn,
  referrerOfIn,
  REFERRALS,
  type ReferralRefusal,
} from '@hatti/messaging/public';
import type { CurrencyCode } from '@hatti/money';
import {
  OrderEvents,
  customerOrderTracesIn,
  orderReferralFactsIn,
  type FulfillmentUpdatedPayload,
  type OrderTrace,
} from '@hatti/orders/public';

/** The stages of an order its customer has: delivered, or picked up (ADR-389). */
const RECEIVED = new Set(['delivered', 'completed']);

/**
 * The ID of the credit a referral gives `side`: the same however often it is asked for, so that
 * it is given once (ADR-807).
 */
export function referralCreditId(orderId: string, side: 'referrer' | 'friend'): string {
  const hex = createHash('sha256').update(`referral:${side}:${orderId}`).digest('hex');
  // A UUID's version 8, for one of the caller's own making, and its variant.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** An address as two orders' are compared: its words, whatever their case, spaces or commas. */
const placeOf = (trace: OrderTrace) =>
  `${trace.address1} ${trace.city}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether two orders came from one device: the same address online and the same browser. */
const sameDevice = (a: OrderTrace, b: OrderTrace) =>
  a.clientIp !== null && a.clientIp === b.clientIp && a.userAgent === b.userAgent;

/**
 * Referrals (MKT-07, ADR-807): while the shop's programme is on, once an order placed from a
 * customer's link (its landing page's `invite`) is delivered, paid in full and not cancelled, the
 * customer whose code it was and the friend who placed it are each given the programme's store
 * credit, lasting its days; checkout spends it, and WhatsApp tells them of it (ADR-192). The
 * checks against fraud refuse it where the order is the referrer's own, the friend ordered
 * before, it came from the referrer's device or went to one of the referrer's addresses, the
 * referrer has had no order of their own delivered and paid, or was rewarded as often as 30 days
 * allow, or the friend's goods came to less than the programme asks. Each order is dealt with
 * once, either way, and kept for the admin to see.
 */
export class ReferralRewards {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderPaid,
    OrderEvents.FulfillmentUpdated,
  ];

  constructor(private readonly database: Database) {}

  /** What became of the order's referral; null where it was none, or not yet due. */
  async handle(
    event: DomainEvent,
    at: Date = new Date(),
  ): Promise<{ rewarded: true } | { rewarded: false; reason: ReferralRefusal } | null> {
    let orderId = event.aggregateId;
    if (event.type === OrderEvents.FulfillmentUpdated) {
      const payload = event.payload as Partial<FulfillmentUpdatedPayload>;
      if (!payload.orderId || payload.status !== 'delivered') return null;
      orderId = payload.orderId;
    }
    const { shopId } = event;
    return this.database.tenant(shopId, async (tx) => {
      const program = await referralProgramIn(tx, shopId);
      if (!program) return null;
      const order = await orderReferralFactsIn(tx, shopId, orderId);
      if (
        !order?.referralCode ||
        order.erased ||
        order.status === 'cancelled' ||
        !RECEIVED.has(order.stage) ||
        order.amountPaid < order.total
      ) {
        return null;
      }
      const referrerId = await referrerOfIn(tx, shopId, order.referralCode);
      if (!referrerId || (await referralRecordedIn(tx, shopId, order.id))) return null;
      const referrer = await customerOrderTracesIn(tx, shopId, referrerId);
      const reason: ReferralRefusal | null =
        referrerId === order.customerId
          ? 'own_code'
          : order.otherOrders > 0
            ? 'not_first_order'
            : referrer.traces.some((trace) => sameDevice(trace, order))
              ? 'same_device'
              : referrer.traces.some((trace) => placeOf(trace) === placeOf(order))
                ? 'same_address'
                : !referrer.received
                  ? 'referrer_unproven'
                  : order.goods < program.minimumOrder
                    ? 'below_minimum'
                    : (await referralsRewardedIn(tx, shopId, referrerId, at)) >= REFERRALS.perMonth
                      ? 'monthly_limit'
                      : null;
      const referral = {
        orderId: order.id,
        referrerId,
        friendId: order.customerId,
        reason,
      };
      if (reason) {
        await recordReferralIn(
          tx,
          shopId,
          { ...referral, outcome: 'refused', referrerCredit: 0n, friendCredit: 0n },
          at,
        );
        return { rewarded: false, reason };
      }
      const expiresAt = new Date(at.getTime() + program.creditDays * 86_400_000);
      const currency = order.currency as CurrencyCode;
      const name = `#${order.number}`;
      const given = await creditStoreCreditIn(
        tx,
        { shopId, actor: 'system' },
        {
          id: referralCreditId(order.id, 'referrer'),
          customerId: referrerId,
          currency,
          amount: program.referrerCredit,
          event: 'adjustment',
          expiresAt,
          note: `Referral: a friend's first order, ${name}`,
        },
        ['referrerId'],
        at,
      );
      if (!given.ok) return null;
      if (program.friendCredit > 0n) {
        const friend = await creditStoreCreditIn(
          tx,
          { shopId, actor: 'system' },
          {
            id: referralCreditId(order.id, 'friend'),
            customerId: order.customerId,
            currency,
            amount: program.friendCredit,
            event: 'adjustment',
            orderId: order.id,
            expiresAt,
            note: `Referral: welcome, for order ${name}`,
          },
          ['orderId'],
          at,
        );
        if (!friend.ok) return null;
      }
      await recordReferralIn(
        tx,
        shopId,
        {
          ...referral,
          outcome: 'rewarded',
          referrerCredit: program.referrerCredit,
          friendCredit: program.friendCredit,
        },
        at,
      );
      return { rewarded: true };
    });
  }
}

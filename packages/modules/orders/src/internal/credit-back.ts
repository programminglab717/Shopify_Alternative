import {
  giveBackOrderCreditIn,
  giveBackOrderGiftCardsIn,
  revertOrderGiftCardsIn,
  revertOrderStoreCreditIn,
} from '@hatti/customers/public';
import type { Actor } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import type { OrderRow } from './schema.js';

/**
 * Gives the `credit` of store credit that paid order `orderId` back to its customer, as when it
 * is cancelled or its parcels come back: all of it, the payment void (ADR-185), where `left` of
 * what was paid is past its refunds; else as much as they left, to the credits it came from
 * (ADR-663). What it gave back, for the order's paid amount to drop by.
 */
export async function giveCreditBackIn(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  orderId: string,
  credit: bigint,
  left: bigint,
): Promise<bigint> {
  if (credit === 0n || left <= 0n) return 0n;
  if (left >= credit) return revertOrderStoreCreditIn(tx, shopId, actor, orderId);
  return giveBackOrderCreditIn(tx, shopId, actor, orderId, left);
}

/** The timeline's words for `given` of the `credit` of store credit that paid `order` given back. */
export function creditBackText(
  order: OrderRow,
  credit: bigint,
  given: bigint,
  left: bigint,
  why = '',
): string {
  const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
  if (left <= 0n) return `${rupees(credit)} of store credit paid it; refunds gave back all it paid`;
  if (given === credit) {
    return `Gave ${rupees(credit)} of store credit, which paid it, back to its customer${why}`;
  }
  if (given > 0n) {
    return (
      `Gave ${rupees(given)} of the ${rupees(credit)} of store credit that paid it back to its ` +
      `customer${why}, what refunds left of what was paid`
    );
  }
  return (
    `${rupees(credit)} of store credit paid it, more than refunds left of what was paid: give ` +
    'back what is owed as a refund'
  );
}

/**
 * Gives the `cards` that gift cards paid of order `orderId` back to them when it is cancelled: all
 * of it, the payment void (ADR-449), where `left` of what was paid is past its refunds and the
 * store credit given back; else as much as that leaves (ADR-664). What it gave back.
 */
export async function giveCardsBackIn(
  tx: Tx,
  shopId: string,
  actor: Actor | 'system',
  orderId: string,
  cards: bigint,
  left: bigint,
): Promise<bigint> {
  if (cards === 0n || left <= 0n) return 0n;
  if (left >= cards) return revertOrderGiftCardsIn(tx, shopId, actor, orderId);
  return giveBackOrderGiftCardsIn(tx, shopId, actor, orderId, left);
}

/** The timeline's words for `given` of the `cards` that gift cards paid of `order` given back. */
export function cardsBackText(order: OrderRow, cards: bigint, given: bigint, left: bigint): string {
  const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
  if (left <= 0n) {
    return `${rupees(cards)} of gift cards paid it; refunds and store credit gave back all it paid`;
  }
  if (given === cards) return `Gave ${rupees(cards)} back to the gift cards that paid it`;
  if (given > 0n) {
    return (
      `Gave ${rupees(given)} of the ${rupees(cards)} gift cards paid back to them, what refunds ` +
      'and store credit left of what was paid'
    );
  }
  return (
    `${rupees(cards)} of gift cards paid it, more than refunds left of what was paid: give back ` +
    'what is owed as a refund'
  );
}

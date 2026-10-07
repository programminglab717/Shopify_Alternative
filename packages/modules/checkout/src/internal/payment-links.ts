import type { InputChecker } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { and, eq, sql } from 'drizzle-orm';
import { CART_LIMITS } from './cart-lines.js';
import { paymentLinks, type PaymentLinkRow } from './schema.js';

// Payment links (PAY-04, ADR-248): a link the shop shares once, on WhatsApp, Instagram or
// anywhere, that many customers open, each to a checkout of their own with the link's items.

/** Where a link opens, on the shop's storefront: /pay/<token>. */
export const PAYMENT_LINK_PATH = 'pay';

export const PAYMENT_LINK_LIMITS = {
  /** Items in one link, each a variant once. */
  items: 20,
  title: 255,
  usageLimit: 100_000,
  /** The links a page of the shop's list gives. */
  page: 50,
} as const;

/** An item a link puts in each checkout it opens. */
export interface PaymentLinkItemValue {
  variantId: string;
  quantity: number;
}

/** What staff give for a new link, or change of one: a field absent stays as it is. */
export interface PaymentLinkInput {
  title?: string | null;
  items?: readonly { variantId: string; quantity?: number | null }[] | null;
  /** The discount code each checkout gets; blank or null for none. */
  discountCode?: string | null;
  /** Paid before it ships, by transfer or online: no cash on delivery. */
  prepaidOnly?: boolean | null;
  /** How many orders it takes before it closes; null for no limit. */
  usageLimit?: number | null;
  /** When it closes; null for never. */
  expiresAt?: Date | null;
  /** False closes it; true opens it again. */
  active?: boolean | null;
}

/** A link as staff see it. */
export interface PaymentLinkRecord {
  id: string;
  title: string;
  /** Where customers open it: on the shop's storefront, /pay/<token>. */
  url: string;
  items: PaymentLinkItemRecord[];
  discountCode: string | null;
  prepaidOnly: boolean;
  usageLimit: number | null;
  /** The orders placed through it so far. */
  ordersPlaced: number;
  lastOrderAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
  /** Whether it opens checkouts now: active, not past its time, nor used up. */
  open: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentLinkItemRecord extends PaymentLinkItemValue {
  /** The product's title, with the variant's where it has more than one; null once it is gone. */
  title: string | null;
}

/** Whether a link opens checkouts at `now`, and takes their orders. */
export function linkIsOpen(
  link: {
    active: boolean;
    expiresAt: Date | null;
    usageLimit: number | null;
    ordersPlaced: number;
  },
  now: Date,
): boolean {
  return (
    link.active &&
    (link.expiresAt === null || link.expiresAt > now) &&
    (link.usageLimit === null || link.ordersPlaced < link.usageLimit)
  );
}

/** The shop's link with `id`, in the caller's transaction `tx`, locked with `lock`; null if none. */
export async function paymentLinkIn(
  tx: Tx,
  shopId: string,
  id: string,
  lock: boolean,
): Promise<PaymentLinkRow | null> {
  const query = tx
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.shopId, shopId), eq(paymentLinks.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/** Counts an order placed through the link with `id`, in the caller's transaction `tx`. */
export async function countLinkOrderIn(tx: Tx, shopId: string, id: string): Promise<void> {
  await tx
    .update(paymentLinks)
    .set({ ordersPlaced: sql`${paymentLinks.ordersPlaced} + 1`, lastOrderAt: sql`now()` })
    .where(and(eq(paymentLinks.shopId, shopId), eq(paymentLinks.id, id)));
}

/**
 * A link's items as given, each variant once, its quantities added up: errors go under
 * `field`, by the item's place.
 */
export function checkLinkItems(
  check: InputChecker,
  field: string[],
  items: readonly { variantId: string; quantity?: number | null }[],
): PaymentLinkItemValue[] | null {
  if (items.length === 0) {
    check.addMessage(field, 'BLANK', 'Add at least one item');
    return null;
  }
  if (items.length > PAYMENT_LINK_LIMITS.items) {
    check.addMessage(field, 'TOO_MANY', `A link holds at most ${PAYMENT_LINK_LIMITS.items} items`);
    return null;
  }
  const kept = new Map<string, number>();
  items.forEach((item, index) => {
    const quantity = check.integer([...field, String(index), 'quantity'], item.quantity ?? 1, {
      min: 1,
      max: CART_LIMITS.quantity,
    });
    if (quantity === null) return;
    const total = (kept.get(item.variantId) ?? 0) + quantity;
    if (total > CART_LIMITS.quantity) {
      check.add(
        [...field, String(index), 'quantity'],
        'INVALID',
        `must come to at most ${CART_LIMITS.quantity} with the variant's other items`,
      );
      return;
    }
    kept.set(item.variantId, total);
  });
  return [...kept].map(([variantId, quantity]) => ({ variantId, quantity }));
}

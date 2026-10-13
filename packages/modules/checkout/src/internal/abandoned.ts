// Abandoned checkouts and their reminder (CHK-12, ADR-393): what a checkout keeps of the shopper
// who typed their number and left, and the link the reminder carries back to their items.
import type { CartJson } from '@hatti/storefront-api';

/** Where a reminder's link is, on the core's own address: /r/<secret>. */
export const REMINDER_LINK_PATH = 'r';

/** The delays, in minutes, a shop may remind shoppers after; none for never. */
export const REMINDER_DELAYS = [30, 60, 180, 600] as const;
export type ReminderDelay = (typeof REMINDER_DELAYS)[number];

export const ABANDONED = {
  /** How long a checkout with a number is kept for the shop to see, past its page's day. */
  keptDays: 30,
  /** Shoppers who left longer ago than this are not reminded, as when the shop turns it on. */
  remindWithinHours: 24,
  /** An order the same number places this long after leaving recovers the checkout. */
  recoveredWithinDays: 7,
} as const;

/** An item as the cart held it when the shopper typed their number. */
export interface ContactLineValue {
  variantId: string;
  title: string;
  variantTitle: string;
  quantity: number;
}

/** The cart's items as a checkout keeps them with the shopper's number. */
export function contactLinesOf(cart: Pick<CartJson, 'items'>): ContactLineValue[] {
  return cart.items.map((item) => ({
    variantId: item.variantId,
    title: item.title,
    variantTitle: item.variantTitle,
    quantity: item.quantity,
  }));
}

/**
 * The storefront's cart permalink for the items (CH-07): `/cart/{variant}:{quantity},…`, which
 * fills a cart with them and opens its checkout; the storefront's home with none.
 */
export function permalinkOf(lines: readonly ContactLineValue[]): string {
  if (lines.length === 0) return '/';
  return `/cart/${lines.map((line) => `${line.variantId}:${line.quantity}`).join(',')}`;
}

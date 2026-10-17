import { discountStatus } from './discounts.js';
import { forSomeItems, itemsFor, itemsOff, type OrderItems } from './items.js';
import type { AutomaticDiscountRecord, DiscountCodeRecord } from './records.js';

/** The discounts an order takes, and what they take off it together (ADR-515). */
export interface ChosenDiscounts {
  /** The code applied: null when none was given, or it was set aside. */
  code: DiscountCodeRecord | null;
  /**
   * A code that works but was set aside: automatic discounts that take more off the items apply
   * instead, and one of them doesn't combine with codes.
   */
  setAside: DiscountCodeRecord | null;
  /** The automatic discounts applied: the one that takes most off the items, and free delivery. */
  automatic: AutomaticDiscountRecord[];
  /** Off the items by them all, no more than the items come to. */
  items: bigint;
  /** Of `items`, what the code takes off. */
  byCode: bigint;
  /** Of `items`, what the automatic discounts take off. */
  byAutomatic: bigint;
  /** Whether one of them makes delivery free. */
  freeDelivery: boolean;
}

/** An order without discounts. */
export const NO_DISCOUNTS: ChosenDiscounts = {
  code: null,
  setAside: null,
  automatic: [],
  items: 0n,
  byCode: 0n,
  byAutomatic: 0n,
  freeDelivery: false,
};

/**
 * The discounts an order with `items` takes, at `at` (ADR-515): of the shop's automatic discounts
 * that run and whose minimum the items reach, the one that takes most off the items (the oldest of
 * equals) and the oldest giving free delivery; and `code`, a code the caller found works for the
 * order, beside them where every one applied combines with codes. Where one doesn't, the code
 * applies alone unless they take more off the items than it does. Each takes its share of the
 * items it is for (ADR-517) as they come before any discount; together, no more than the items.
 */
export function chooseDiscounts(
  items: OrderItems,
  code: DiscountCodeRecord | null,
  automatics: readonly AutomaticDiscountRecord[],
  at: Date = new Date(),
): ChosenDiscounts {
  const { subtotal } = items;
  const qualifying = automatics.filter((discount) => {
    const its = itemsFor(discount, items);
    return (
      discountStatus(discount, at) === 'active' &&
      !(forSomeItems(discount) && its === 0n) &&
      (discount.minimumSubtotal === null || its >= discount.minimumSubtotal)
    );
  });
  const off = (discount: AutomaticDiscountRecord | DiscountCodeRecord) => itemsOff(discount, items);
  let best: AutomaticDiscountRecord | null = null;
  for (const discount of qualifying) {
    // Buying too few for one that gives items takes nothing (ADR-519).
    if (discount.kind === 'free_shipping' || off(discount) === 0n) continue;
    if (best === null || off(discount) > off(best)) best = discount;
  }
  const delivery = qualifying.find((discount) => discount.kind === 'free_shipping') ?? null;
  const automatic = [best, delivery].filter((discount) => discount !== null);
  const byAutomatic = best ? off(best) : 0n;

  const chosen = (
    applied: DiscountCodeRecord | null,
    setAside: DiscountCodeRecord | null,
    taken: AutomaticDiscountRecord[],
  ): ChosenDiscounts => {
    const fromCode = applied ? off(applied) : 0n;
    const fromAutomatic = taken.reduce((sum, discount) => sum + off(discount), 0n);
    const items = fromCode + fromAutomatic > subtotal ? subtotal : fromCode + fromAutomatic;
    return {
      code: applied,
      setAside,
      automatic: taken,
      items,
      byCode: fromCode > items ? items : fromCode,
      byAutomatic: items - (fromCode > items ? items : fromCode),
      freeDelivery:
        applied?.kind === 'free_shipping' ||
        taken.some((discount) => discount.kind === 'free_shipping'),
    };
  };

  if (code === null || automatic.length === 0) return chosen(code, null, automatic);
  if (automatic.every((discount) => discount.combinesWithCodes)) {
    return chosen(code, null, automatic);
  }
  return byAutomatic > off(code) ? chosen(null, code, automatic) : chosen(code, null, []);
}

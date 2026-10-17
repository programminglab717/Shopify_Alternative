import { divideRounded } from '@hatti/money';
import { discountOf } from './discounts.js';
import type { DiscountCodeRecord } from './records.js';

/** One of an order's lines as discounts see it (ADR-517). */
export interface ItemLine {
  productId: string;
  /** Of the collections discounts name, those its product is in. */
  collectionIds: readonly string[];
  /** Units of it. */
  quantity: number;
  /** What the line comes to before any discount, in minor units. */
  total: bigint;
}

/** An order's items as discounts see them: what they come to, and each line (ADR-517). */
export interface OrderItems {
  subtotal: bigint;
  lines: readonly ItemLine[];
}

type Scoped = Pick<DiscountCodeRecord, 'productIds' | 'collectionIds'>;

/** Whether a discount is for some products or collections only, not the whole order. */
export function forSomeItems(discount: Scoped): boolean {
  return discount.productIds.length > 0 || discount.collectionIds.length > 0;
}

/**
 * What the items a discount is for come to (ADR-517): the whole order's, or of its lines those
 * whose product it names or that are in a collection it names.
 */
export function itemsFor(discount: Scoped, items: OrderItems): bigint {
  if (!forSomeItems(discount)) return items.subtotal;
  return linesFor(discount, items).reduce((sum, line) => sum + line.total, 0n);
}

/** Of the order's lines, those a discount is for: all of them for the whole order. */
function linesFor(discount: Scoped, items: OrderItems): readonly ItemLine[] {
  if (!forSomeItems(discount)) return items.lines;
  const products = new Set(discount.productIds);
  const collections = new Set(discount.collectionIds);
  return items.lines.filter(
    (line) => products.has(line.productId) || line.collectionIds.some((id) => collections.has(id)),
  );
}

type Offer = Pick<
  DiscountCodeRecord,
  | 'kind'
  | 'percentageBps'
  | 'amount'
  | 'buyQuantity'
  | 'getQuantity'
  | 'productIds'
  | 'collectionIds'
>;

/**
 * What a discount takes off the items it is for (ADR-517), in minor units: a percentage of them,
 * an amount no more than they come to, nothing for free delivery; or, buying X to get Y
 * (ADR-519), in each full group of X + Y of its items, the Y cheapest at its percentage off,
 * each rounded half up.
 */
export function itemsOff(discount: Offer, items: OrderItems): bigint {
  if (discount.kind !== 'buy_x_get_y') {
    return discountOf(discount, { subtotal: itemsFor(discount, items), shipping: 0n }).items;
  }
  const buy = discount.buyQuantity ?? 0;
  const get = discount.getQuantity ?? 0;
  if (buy < 1 || get < 1) return 0n;
  const lines = linesFor(discount, items).filter((line) => line.quantity > 0);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  let given = Math.floor(units / (buy + get)) * get;
  // The cheapest first, each line's units at its price.
  const cheapest = [...lines].sort((a, b) => {
    const each = (line: ItemLine) => line.total / BigInt(line.quantity);
    return each(a) < each(b) ? -1 : each(a) > each(b) ? 1 : 0;
  });
  let off = 0n;
  for (const line of cheapest) {
    if (given === 0) break;
    const taken = Math.min(given, line.quantity);
    const each = line.total / BigInt(line.quantity);
    off += divideRounded(
      each * BigInt(taken) * BigInt(discount.percentageBps ?? 0),
      10_000n,
      'half-up',
    );
    given -= taken;
  }
  return off;
}

/**
 * The collections `discounts` name, which the caller looks up its lines' products in to build
 * {@link OrderItems}; none to look up when no discount names one.
 */
export function collectionsNamed(discounts: readonly (Scoped | null)[]): string[] {
  return [...new Set(discounts.flatMap((discount) => discount?.collectionIds ?? []))];
}

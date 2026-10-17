import type { DiscountCodeRecord } from './records.js';

/** One of an order's lines as discounts see it (ADR-517). */
export interface ItemLine {
  productId: string;
  /** Of the collections discounts name, those its product is in. */
  collectionIds: readonly string[];
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
  const products = new Set(discount.productIds);
  const collections = new Set(discount.collectionIds);
  return items.lines
    .filter(
      (line) =>
        products.has(line.productId) || line.collectionIds.some((id) => collections.has(id)),
    )
    .reduce((sum, line) => sum + line.total, 0n);
}

/**
 * The collections `discounts` name, which the caller looks up its lines' products in to build
 * {@link OrderItems}; none to look up when no discount names one.
 */
export function collectionsNamed(discounts: readonly (Scoped | null)[]): string[] {
  return [...new Set(discounts.flatMap((discount) => discount?.collectionIds ?? []))];
}

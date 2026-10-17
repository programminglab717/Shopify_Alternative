import { collectionsOfProductsIn } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { collectionsNamed, type DiscountCodeRecord, type OrderItems } from '@hatti/pricing/public';
import type { CartJson } from '@hatti/storefront-api';

/**
 * A cart's items as `discounts` see them (ADR-517): each line's product and what it comes to, with
 * the collections they name that its product is in, asked of the catalog only when one names any.
 */
export async function orderItemsIn(
  tx: Tx,
  shopId: string,
  cart: Pick<CartJson, 'subtotal' | 'items'>,
  discounts: readonly (Pick<DiscountCodeRecord, 'productIds' | 'collectionIds'> | null)[],
): Promise<OrderItems> {
  const named = collectionsNamed(discounts);
  const collections =
    named.length === 0
      ? new Map<string, string[]>()
      : await collectionsOfProductsIn(
          tx,
          shopId,
          cart.items.map((item) => item.productId),
          named,
        );
  return {
    subtotal: BigInt(cart.subtotal),
    lines: cart.items.map((item) => ({
      productId: item.productId,
      collectionIds: collections.get(item.productId) ?? [],
      total: BigInt(item.linePrice),
    })),
  };
}

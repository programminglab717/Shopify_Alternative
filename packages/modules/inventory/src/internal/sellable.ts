import type { Tx } from '@hatti/db';
import { availableForSale, loadItems, untrackedItem } from './item-store.js';

/**
 * Which of `variantIds` can be bought online now, in the caller's transaction, as the storefront
 * has it (`InventoryService.availableOf`): for the AI answering the shop's customers (MSG-07,
 * ADR-911). A variant whose stock was never recorded can be bought.
 */
export async function sellableIn(
  tx: Tx,
  shopId: string,
  variantIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (variantIds.length === 0) return new Map();
  const loaded = await loadItems(tx, shopId, variantIds);
  return new Map(
    variantIds.map((id) => [id, availableForSale(loaded.get(id) ?? untrackedItem(id))]),
  );
}

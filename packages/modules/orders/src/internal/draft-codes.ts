import { collectionsOfProductsIn } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import {
  collectionsNamed,
  discountCodeIn,
  discountFor,
  typedCode,
  type AppliedDiscount,
  type DiscountRefusal,
} from '@hatti/pricing/public';
import type { DraftLineValue } from './schema.js';

/**
 * The shop's code `typed` put to a draft's lines and delivery charge (ADR-521), as checkout puts a
 * cart's (ADR-517, ADR-519): what it takes off, or why it takes nothing. Whether the customer used
 * it already is known once the draft is an order.
 */
export async function draftCodeIn(
  tx: Tx,
  shopId: string,
  typed: string,
  lines: readonly DraftLineValue[],
  shipping: bigint,
): Promise<AppliedDiscount> {
  const text = typedCode(typed);
  const record = text === null ? null : await discountCodeIn(tx, shopId, text);
  if (!record) return { ok: false, refusal: { reason: 'unknown' } };
  const named = collectionsNamed([record]);
  const collections =
    named.length === 0
      ? new Map<string, string[]>()
      : await collectionsOfProductsIn(
          tx,
          shopId,
          lines.map((line) => line.productId),
          named,
        );
  const items = lines.map((line) => ({
    productId: line.productId,
    collectionIds: collections.get(line.productId) ?? [],
    quantity: line.quantity,
    total: BigInt(line.unitPrice) * BigInt(line.quantity),
  }));
  const subtotal = items.reduce((sum, line) => sum + line.total, 0n);
  return discountFor(record, { subtotal, shipping, lines: items });
}

/** Why a draft's code takes nothing, for staff. */
export function codeRefusalText(
  code: string,
  refusal: DiscountRefusal,
  currency: CurrencyCode,
): string {
  switch (refusal.reason) {
    case 'unknown':
      return `The shop has no code ${code.trim()}`;
    case 'scheduled':
      return `${code} hasn't started yet`;
    case 'expired':
      return `${code} has ended`;
    case 'minimum':
      return `${code} is for orders of ${formatMoney(money(refusal.minimum, currency))} or more`;
    case 'not_for_items':
      return `${code} isn't for these items`;
    case 'too_few':
      return `${code} needs ${refusal.count} of its items`;
    case 'used_up':
      return `${code} has been used up`;
    case 'used':
      return `The customer has used ${code} before, and it is for one order each`;
  }
}

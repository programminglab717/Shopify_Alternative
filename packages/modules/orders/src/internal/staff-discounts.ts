import { hasCapability, type Actor } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { orderSettingsIn } from './order-settings.service.js';

/**
 * Whether `actor` takes any discount off an order (ADR-651): apps and Hatti's support as their
 * scopes allow, staff with `give_any_discount`.
 */
export function givesAnyDiscount(actor: Actor): boolean {
  return actor.kind !== 'staff' || hasCapability(actor, 'give_any_discount');
}

/**
 * Why `actor` may not raise a discount from `before` to `discount` off items costing `items`
 * (ADR-651): past the shop's share of them, which staff without `give_any_discount` keep to;
 * null where they may. A discount lowered, or kept, is never refused.
 */
export async function staffDiscountRefusal(
  tx: Tx,
  shopId: string,
  actor: Actor,
  amounts: { items: bigint; before: bigint; discount: bigint },
  format: (amount: bigint) => string,
): Promise<string | null> {
  if (amounts.discount <= amounts.before || givesAnyDiscount(actor)) return null;
  const { staffDiscountPercent: percent } = await orderSettingsIn(tx, shopId);
  if (percent === null) return null;
  const most = (amounts.items * BigInt(percent)) / 100n;
  return amounts.discount > most
    ? `Your role takes ${percent}% off at most, ${format(most)}: ask an owner or a manager to ` +
        'give more'
    : null;
}

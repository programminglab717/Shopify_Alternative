import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { and, eq, sql } from 'drizzle-orm';
import { discountCodeIn, toRecord } from './discount-code.service.js';
import { discountOf, discountStatus, typedCode, type DiscountAmounts } from './discounts.js';
import { PricingEvents, type DiscountCodeRedeemedPayload } from './events.js';
import { forSomeItems, itemsFor, type OrderItems } from './items.js';
import type { DiscountCodeRecord } from './records.js';
import { discountCodes, discountRedemptions } from './schema.js';

/** Why a code does not take anything off an order. */
export type DiscountRefusal =
  /** The shop has no such code, or what was typed cannot be one. */
  | { reason: 'unknown' }
  | { reason: 'scheduled'; startsAt: Date }
  | { reason: 'expired' }
  /** The items come to less than the code needs. */
  | { reason: 'minimum'; minimum: bigint }
  /** It is for some products or collections, and the order has none of their items. */
  | { reason: 'not_for_items' }
  /** Its orders have all been placed. */
  | { reason: 'used_up' }
  /** The customer placed an order with it already, and it is once a customer. */
  | { reason: 'used' };

/** A code put to an order: what it takes off, or why it takes nothing. */
export type AppliedDiscount =
  | { ok: true; code: DiscountCodeRecord; amounts: DiscountAmounts }
  | { ok: false; refusal: DiscountRefusal };

/** An order as a code is put to it: its items, each line if a code may be for some, and delivery. */
export interface DiscountedOrder {
  subtotal: bigint;
  shipping: bigint;
  /** Its lines (ADR-517); left out, a code for some products or collections finds none. */
  lines?: OrderItems['lines'];
}

/**
 * What the shop's code `typed` takes off an order whose items come to `subtotal` and whose
 * delivery costs `shipping`, at `at`, in the caller's transaction `tx`; or why it takes nothing.
 * Whether the order's customer used it already is known only once the order has its customer:
 * {@link redeemDiscountIn} says.
 */
export async function applyDiscountIn(
  tx: Tx,
  shopId: string,
  typed: string,
  order: DiscountedOrder,
  at: Date = new Date(),
): Promise<AppliedDiscount> {
  const text = typedCode(typed);
  const code = text === null ? null : await discountCodeIn(tx, shopId, text);
  if (!code) return { ok: false, refusal: { reason: 'unknown' } };
  return discountFor(code, order, at);
}

/**
 * What `code` takes off the order, by its dates, minimum and uses; one for some products or
 * collections (ADR-517) off their items alone, its minimum being what they come to.
 */
export function discountFor(
  code: DiscountCodeRecord,
  order: DiscountedOrder,
  at: Date = new Date(),
): AppliedDiscount {
  const status = discountStatus(code, at);
  if (status === 'scheduled') {
    return { ok: false, refusal: { reason: 'scheduled', startsAt: code.startsAt } };
  }
  if (status === 'expired') return { ok: false, refusal: { reason: 'expired' } };
  const items = itemsFor(code, { subtotal: order.subtotal, lines: order.lines ?? [] });
  if (forSomeItems(code) && items === 0n)
    return { ok: false, refusal: { reason: 'not_for_items' } };
  if (code.minimumSubtotal !== null && items < code.minimumSubtotal) {
    return { ok: false, refusal: { reason: 'minimum', minimum: code.minimumSubtotal } };
  }
  if (code.usageLimit !== null && code.used >= code.usageLimit) {
    return { ok: false, refusal: { reason: 'used_up' } };
  }
  return {
    ok: true,
    code,
    amounts: discountOf(code, { subtotal: items, shipping: order.shipping }),
  };
}

/**
 * Counts a use of the code `codeId` by the order just placed with it, in the caller's
 * transaction `tx`, which placed the order: refused when its uses have run out since, or when it
 * is once a customer and the order's customer used it already. A refusal leaves the code as it
 * was; the caller rolls back the order. Records `discount_code.redeemed`.
 */
export async function redeemDiscountIn(
  tx: Tx,
  shopId: string,
  redemption: { codeId: string; orderId: string; customerId: string; amount: bigint },
): Promise<{ ok: true } | { ok: false; refusal: DiscountRefusal }> {
  const { codeId, orderId, customerId, amount } = redemption;
  const [row] = await tx
    .select()
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, codeId)))
    .for('update');
  if (!row) return { ok: false, refusal: { reason: 'unknown' } };
  const code = toRecord(row);
  if (code.usageLimit !== null && code.used >= code.usageLimit) {
    return { ok: false, refusal: { reason: 'used_up' } };
  }
  if (code.oncePerCustomer) {
    const [used] = await tx
      .select({ orderId: discountRedemptions.orderId })
      .from(discountRedemptions)
      .where(
        and(
          eq(discountRedemptions.shopId, shopId),
          eq(discountRedemptions.codeId, codeId),
          eq(discountRedemptions.customerId, customerId),
        ),
      )
      .limit(1);
    if (used) return { ok: false, refusal: { reason: 'used' } };
  }
  await tx
    .update(discountCodes)
    .set({ used: sql`${discountCodes.used} + 1` })
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, codeId)));
  await tx.insert(discountRedemptions).values({ shopId, codeId, orderId, customerId, amount });
  await appendEvent<DiscountCodeRedeemedPayload>(tx, shopId, {
    type: PricingEvents.DiscountCodeRedeemed,
    aggregateType: 'discount_code',
    aggregateId: codeId,
    payload: { code: code.code, orderId, amount: amount.toString() },
  });
  return { ok: true };
}

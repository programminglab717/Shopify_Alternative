import { divideRounded } from '@hatti/money';
import { taxesByRate } from '@hatti/tax/public';
import type { OrderRecord } from './records.js';

/**
 * An order's sales tax by rate, lowest first (ADR-096, ADR-097): its lines', each at the rate it
 * was taxed at, and its charges' at the shop's rate when it was placed. Empty for an order with
 * none.
 */
export function taxByRate(
  order: Pick<OrderRecord, 'lines' | 'taxRate' | 'shippingTax'>,
): Map<number, bigint> {
  return taxesByRate([
    ...order.lines.map((line) => ({ rate: line.taxRate, tax: line.tax })),
    { rate: order.taxRate, tax: order.shippingTax },
  ]);
}

/**
 * The sales tax in a refund of `amount` (ADR-105): the order's tax in all it has refunded with
 * this one, in proportion to its total, less `refundedTax`, what the refunds before it gave back.
 * Refunds of a whole order give back all its tax, however many there are. Never less than nothing
 * nor more than the refund.
 */
export function refundTaxOf(
  order: { total: bigint; totalTax: bigint; amountRefunded: bigint },
  amount: bigint,
  refundedTax: bigint,
): bigint {
  if (order.total <= 0n || order.totalTax <= 0n) return 0n;
  const upto = divideRounded(
    (order.amountRefunded + amount) * order.totalTax,
    order.total,
    'half-up',
  );
  const tax = upto - refundedTax;
  return tax < 0n ? 0n : tax > amount ? amount : tax;
}

/** The sales tax an order keeps now: what it was placed with, less what its refunds gave back. */
export function currentTaxOf(order: Pick<OrderRecord, 'totalTax' | 'refunds'>): bigint {
  return order.refunds.reduce((tax, refund) => tax - refund.tax, order.totalTax);
}

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

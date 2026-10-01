import type { OrderRecord } from './records.js';

/**
 * An order's sales tax by rate, lowest first (ADR-096): its lines', each at the rate it was taxed
 * at, and its charges' at the shop's rate when it was placed. Empty for an order with none.
 */
export function taxByRate(
  order: Pick<OrderRecord, 'lines' | 'taxRate' | 'shippingTax'>,
): Map<number, bigint> {
  const byRate = new Map<number, bigint>();
  const add = (rate: number, tax: bigint) => byRate.set(rate, (byRate.get(rate) ?? 0n) + tax);
  for (const line of order.lines) if (line.taxRate !== null) add(line.taxRate, line.tax);
  if (order.taxRate !== null && order.shippingTax > 0n) add(order.taxRate, order.shippingTax);
  return new Map([...byRate].sort(([a], [b]) => a - b));
}

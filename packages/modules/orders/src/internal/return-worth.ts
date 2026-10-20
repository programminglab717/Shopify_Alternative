import { allocate, divideRounded, money, type CurrencyCode } from '@hatti/money';

/** What of an order's line {@link paidFor} reckons with. */
export interface PricedLine {
  id: string;
  unitPrice: bigint;
  quantity: number;
  total: bigint;
}

/**
 * What was paid for `back`, units of the order's lines: their prices, less their share of the
 * order's discount, shared by the lines' totals as the tax on them is (ADR-096). A return is worth
 * it (ADR-613), and an exchange is paid by it (ADR-137).
 */
export function paidFor(
  order: { discount: bigint; currency: string },
  orderLines: readonly PricedLine[],
  back: readonly { line: PricedLine; units: number }[],
): bigint {
  const shares = new Map<string, bigint>();
  if (order.discount > 0n) {
    const parts = allocate(
      money(order.discount, order.currency as CurrencyCode),
      orderLines.map((line) => line.total),
    );
    orderLines.forEach((line, index) => shares.set(line.id, parts[index]!.amount));
  }
  return back.reduce((sum, { line, units }) => {
    const share = divideRounded(
      (shares.get(line.id) ?? 0n) * BigInt(units),
      BigInt(line.quantity),
      'half-up',
    );
    return sum + line.unitPrice * BigInt(units) - share;
  }, 0n);
}

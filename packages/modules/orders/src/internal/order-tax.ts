import { divideRounded } from '@hatti/money';
import { orderTaxOf, taxesByRate, type TaxRates } from '@hatti/tax/public';
import type { DraftOrderRecord, OrderRecord } from './records.js';

/** The sales tax a draft's total includes (ADR-106): in all, and by rate, the lowest first. */
export interface DraftTax {
  total: bigint;
  byRate: Map<number, bigint>;
}

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
 * The sales tax an open draft includes at the shop's `settings` now (ADR-106), as placing it now
 * would work it out: on each line, after its share of the discount, at the rate of its variant,
 * which `variants` say is taxed or not and give the tax code of; and on its delivery charge, where
 * the shop's include it. A draft has no fee for paying on delivery. A variant gone since is taxed
 * at the shop's rate, as variants are unless the shop says otherwise; placing the draft fails on
 * it.
 */
export function draftTaxOf(
  settings: TaxRates,
  draft: Pick<DraftOrderRecord, 'lines' | 'discount' | 'shipping'>,
  variants: ReadonlyMap<string, { taxable: boolean; taxCode: string | null }>,
): DraftTax {
  const tax = orderTaxOf(settings, {
    lines: draft.lines.map((line) => {
      const variant = variants.get(line.variantId);
      return {
        total: line.total,
        taxable: variant?.taxable ?? true,
        taxCode: variant?.taxCode ?? null,
      };
    }),
    discount: draft.discount,
    charges: draft.shipping,
  });
  return {
    total: tax.total,
    byRate: taxesByRate([...tax.lines, { rate: tax.rate, tax: tax.charges }]),
  };
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

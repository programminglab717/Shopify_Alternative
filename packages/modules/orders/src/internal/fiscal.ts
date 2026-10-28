import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import type { FbrItemFields, LocationRecord } from '@hatti/inventory/public';
import {
  discountShares,
  type FiscalBuyer,
  type FiscalDocument,
  type FiscalItem,
} from '@hatti/tax/public';
import { addressLines, cityLine } from './documents.js';
import type { OrderRecord } from './records.js';

// What FBR is sent of a shop's invoices and credit notes while it is connected to FBR (POS-04,
// ADR-555, ADR-562): the tax module reports them, the orders module says what they hold.

/** Pakistan's PCT codes are an HS code's 8 digits; null for an HS code of any other length. */
function pctCodeOf(hsCode: string | null | undefined): string | null {
  return hsCode && hsCode.length === 8 ? hsCode : null;
}

/** Cash at the door is cash; whatever was paid ahead went by card, transfer or wallet. */
function paymentModeOf(order: Pick<OrderRecord, 'paymentMethod'>): FiscalDocument['paymentMode'] {
  return order.paymentMethod === 'cash_on_delivery' ? 'cash' : 'card';
}

/** A location's address in a line, as the invoice prints where it ships from; null for none. */
function locationLine(location: LocationRecord): string | null {
  const { address } = location;
  const lines = [address.address1, address.address2, cityLine(address)].filter(Boolean);
  return lines.length > 0 ? lines.join(', ') : null;
}

/**
 * Who the order's invoice is to, as digital invoicing names the buyer (ADR-562): its customer, by
 * the name on its address, where it went, in a line, or, collected, where it was collected.
 */
function buyerOf(
  order: Pick<OrderRecord, 'shippingAddress' | 'deliveryMethod'>,
  from: LocationRecord | null,
): FiscalBuyer {
  const address = order.shippingAddress;
  if (order.deliveryMethod === 'pickup') {
    const at = from ? [from.name, locationLine(from)].filter(Boolean).join(', ') : 'the shop';
    return {
      name: address.name ?? '',
      address: `Collected at ${at}`,
      province: from?.address.provinceCode ?? address.provinceCode,
    };
  }
  return {
    name: address.name ?? '',
    address: addressLines(address).join(', '),
    province: address.provinceCode,
  };
}

/**
 * An order's invoice `usin`, issued at `issuedAt`, as FBR is sent it: a line each, at what was
 * paid for it after its share of the discount, as its tax was worked out (ADR-096), and its
 * delivery charge and fee for paying on delivery as one line more. The items add up to the
 * order's total, and their tax to its tax. Lines go under their variants' PCT codes, in their
 * units and SROs, from `fbr` by variant, where they have them (ADR-557, ADR-895). It is from `from`, the location the order ships
 * from or is collected at, and to its customer, for digital invoicing (ADR-562).
 */
export function fiscalInvoiceOf(
  order: Pick<
    OrderRecord,
    | 'id'
    | 'lines'
    | 'discount'
    | 'shipping'
    | 'codFee'
    | 'shippingTax'
    | 'taxRate'
    | 'paymentMethod'
    | 'shippingAddress'
    | 'deliveryMethod'
  >,
  usin: string,
  issuedAt: Date,
  fbr: ReadonlyMap<string, FbrItemFields> = new Map(),
  from: LocationRecord | null = null,
): FiscalDocument {
  const shares = discountShares(
    order.lines.map((line) => line.total),
    order.discount,
  );
  const items: FiscalItem[] = order.lines.map((line, index) => {
    const fields = fbr.get(line.variantId);
    return {
      code: line.sku || line.variantId,
      // A product without options has the one variant, named as Shopify names it.
      name:
        line.variantTitle && line.variantTitle !== DEFAULT_VARIANT_TITLE
          ? `${line.title} - ${line.variantTitle}`
          : line.title,
      quantity: line.quantity,
      total: line.total - shares[index]!,
      tax: line.tax,
      rate: line.taxRate,
      discount: shares[index]!,
      // An HS code of 8 digits is its PCT code (ADR-557); others are the shop's default's.
      pctCode: pctCodeOf(fields?.hsCode),
      unit: fields?.unit ?? null,
      sroScheduleNo: fields?.sroScheduleNo ?? null,
      sroItemSerialNo: fields?.sroItemSerialNo ?? null,
    };
  });
  const charges = order.shipping + order.codFee;
  if (charges > 0n) {
    items.push({
      code: 'DELIVERY',
      name: 'Delivery',
      quantity: 1,
      total: charges,
      tax: order.shippingTax,
      rate: order.shippingTax > 0n ? order.taxRate : null,
      discount: 0n,
    });
  }
  return {
    kind: 'invoice',
    usin,
    orderId: order.id,
    refUsin: null,
    issuedAt,
    paymentMode: paymentModeOf(order),
    items,
    buyer: buyerOf(order, from),
    sellerAddress: from && locationLine(from),
  };
}

/**
 * A credit note `usin` for a refund of `amount`, `tax` of it sales tax, on the order whose
 * invoice was `invoiceUsin`, as FBR is sent it: one line, as the refund gives back money, not
 * items, at the order's rate where it had tax.
 */
export function fiscalCreditNoteOf(
  order: Pick<OrderRecord, 'id' | 'taxRate' | 'paymentMethod'>,
  refund: { usin: string; invoiceUsin: string; amount: bigint; tax: bigint; issuedAt: Date },
): FiscalDocument {
  return {
    kind: 'credit_note',
    usin: refund.usin,
    orderId: order.id,
    refUsin: refund.invoiceUsin,
    issuedAt: refund.issuedAt,
    paymentMode: paymentModeOf(order),
    items: [
      {
        code: 'REFUND',
        name: 'Refund',
        quantity: 1,
        total: refund.amount,
        tax: refund.tax,
        rate: refund.tax > 0n ? order.taxRate : null,
        discount: 0n,
      },
    ],
  };
}

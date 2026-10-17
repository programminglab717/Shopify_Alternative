// FBR's POS integration (POS-04, TAX-04, ADR-555): what a Tier-1 retailer's POS sends FBR of each
// invoice it issues, as FBR's IMS takes it. Amounts here are in minor units; FBR is sent rupees.

/** FBR's two services: its sandbox, to try a POS on, and the real one. */
export const FBR_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type FbrEnvironment = (typeof FBR_ENVIRONMENTS)[number];

/** What FBR is sent in the shop's name: an invoice, or a credit note correcting one. */
export const FISCAL_KINDS = ['invoice', 'credit_note'] as const;
export type FiscalKind = (typeof FISCAL_KINDS)[number];

/** How a fiscal invoice stands: waiting to reach FBR, reported, refused, or not to be sent. */
export const FISCAL_STATUSES = ['pending', 'reported', 'failed', 'skipped'] as const;
export type FiscalStatus = (typeof FISCAL_STATUSES)[number];

export const FBR_LIMITS = {
  accessToken: 500,
  /** FBR's longest names of items, as POS software keeps them. */
  itemName: 100,
  itemCode: 50,
} as const;

/** How the customer paid: FBR's modes have cash and card, and no bank transfer of their own. */
export type FiscalPaymentMode = 'cash' | 'card';

/** FBR's numbers for them. */
const PAYMENT_MODES: Record<FiscalPaymentMode, number> = { cash: 1, card: 2 };

/** FBR's numbers for an invoice and for a credit note. */
const INVOICE_TYPES: Record<FiscalKind, number> = { invoice: 1, credit_note: 3 };

/** One item as the invoice has it, its amounts in minor units. */
export interface FiscalItem {
  /** The shop's code for it: its SKU, or else its variant's. */
  code: string;
  name: string;
  quantity: number;
  /** What was paid for it, tax included, after its share of the discount. */
  total: bigint;
  /** Of `total`, what was sales tax. */
  tax: bigint;
  /** The rate it was taxed at, in hundredths of a percent; null when it was not. */
  rate: number | null;
  /** What came off it. */
  discount: bigint;
  /** Its own PCT code, 8 digits (ADR-557); the shop's is used for those without. */
  pctCode?: string | null;
}

/** An invoice or credit note the shop issued, as the orders module gives it to report. */
export interface FiscalDocument {
  kind: FiscalKind;
  /** The shop's own number for it, FBR's USIN: "INV/2026-27/00001". */
  usin: string;
  orderId: string;
  /** For a credit note, the invoice it corrects. */
  refUsin: string | null;
  issuedAt: Date;
  paymentMode: FiscalPaymentMode;
  items: readonly FiscalItem[];
}

/** An item as FBR takes it; without a PCT code of its own, the shop's goes as it reports it. */
export interface FbrItemBody {
  ItemCode: string;
  PCTCode?: string;
  ItemName: string;
  Quantity: number;
  TaxRate: number;
  SaleValue: number;
  TotalAmount: number;
  TaxCharged: number;
  Discount: number;
  FurtherTax: number;
  InvoiceType: number;
  RefUSIN: string | null;
}

/** An invoice as FBR takes it, but the shop's POS ID and items' PCT code. */
export interface FbrInvoiceBody {
  InvoiceNumber: string;
  USIN: string;
  DateTime: string;
  TotalBillAmount: number;
  TotalQuantity: number;
  TotalSaleValue: number;
  TotalTaxCharged: number;
  Discount: number;
  FurtherTax: number;
  PaymentMode: number;
  InvoiceType: number;
  RefUSIN: string | null;
  Items: FbrItemBody[];
}

/** An invoice as FBR is sent it: the shop's POS ID, and its PCT code where an item has none. */
export type FbrInvoiceRequest = Omit<FbrInvoiceBody, 'Items'> & {
  POSID: number;
  Items: (FbrItemBody & { PCTCode: string })[];
};

/** Minor units as FBR's rupees, to the paisa. */
function rupees(amount: bigint): number {
  return Number(amount) / 100;
}

/** `at` as FBR writes times, "2026-10-17 14:05:09", in the shop's time zone `timeZone`. */
export function fbrDateTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * What FBR is sent of `document`, issued in the shop's time zone `timeZone`: its totals are its
 * items', so they always add up, and nothing of its customer goes, as FBR asks none of a retail
 * sale.
 */
export function fbrInvoiceBody(document: FiscalDocument, timeZone: string): FbrInvoiceBody {
  const type = INVOICE_TYPES[document.kind];
  const sum = (of: (item: FiscalItem) => bigint) =>
    document.items.reduce((total, item) => total + of(item), 0n);
  return {
    // FBR gives it its number.
    InvoiceNumber: '',
    USIN: document.usin,
    DateTime: fbrDateTime(document.issuedAt, timeZone),
    TotalBillAmount: rupees(sum((item) => item.total)),
    TotalQuantity: document.items.reduce((total, item) => total + item.quantity, 0),
    TotalSaleValue: rupees(sum((item) => item.total - item.tax)),
    TotalTaxCharged: rupees(sum((item) => item.tax)),
    Discount: rupees(sum((item) => item.discount)),
    FurtherTax: 0,
    PaymentMode: PAYMENT_MODES[document.paymentMode],
    InvoiceType: type,
    RefUSIN: document.refUsin,
    Items: document.items.map((item) => ({
      ItemCode: item.code.slice(0, FBR_LIMITS.itemCode),
      ...(item.pctCode && { PCTCode: item.pctCode }),
      ItemName: item.name.slice(0, FBR_LIMITS.itemName),
      Quantity: item.quantity,
      TaxRate: item.rate === null ? 0 : item.rate / 100,
      SaleValue: rupees(item.total - item.tax),
      TotalAmount: rupees(item.total),
      TaxCharged: rupees(item.tax),
      Discount: rupees(item.discount),
      FurtherTax: 0,
      InvoiceType: type,
      RefUSIN: document.refUsin,
    })),
  };
}

/** `body` as the shop's POS `posId` reports it, its items without codes of their own under `pctCode`. */
export function fbrInvoiceRequest(
  body: FbrInvoiceBody,
  posId: number,
  pctCode: string,
): FbrInvoiceRequest {
  return {
    ...body,
    POSID: posId,
    Items: body.Items.map((item) => ({ ...item, PCTCode: item.PCTCode ?? pctCode })),
  };
}

/** A PCT code as FBR's tariff writes it, "6204.4200" or "62044200", as its 8 digits; else null. */
export function pctCodeOf(typed: string): string | null {
  const digits = typed.replace(/[\s.]/g, '');
  return /^[0-9]{8}$/.test(digits) ? digits : null;
}

import type { Tx } from '@hatti/db';
import { harmonizedSystemCodesIn, type LocationRecord } from '@hatti/inventory/public';
import { recordFiscalDocumentsIn } from '@hatti/tax/public';
import { sql } from 'drizzle-orm';
import { fiscalCreditNoteOf, fiscalInvoiceOf } from './fiscal.js';
import type { OrderRecord } from './records.js';

// A shop's invoices in a series of their own (TAX-05, ADR-495): numbered from 1 each tax year,
// which in Pakistan starts on 1 July, with no number skipped or given twice. An order's invoice
// takes its number the first time it is printed, and keeps it. A refund on an order whose
// invoice was issued takes a credit note's number, in a series of its own (ADR-496). While the
// shop is connected to FBR, each is kept to be reported to FBR as it is issued (ADR-555, ADR-562).

/** An order's invoice as issued. */
export interface OrderInvoiceRecord {
  orderId: string;
  /** The year its tax year starts in: 2026 for July 2026 to June 2027. */
  taxYear: number;
  number: number;
  /** "INV/2026-27/00001". */
  name: string;
  issuedAt: Date;
}

/** The year the tax year of `at` starts in, in the time zone `timeZone`. */
export function taxYearOf(at: Date, timeZone: string): number {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number) as [number, number];
  return month >= 7 ? year : year - 1;
}

/** A number in a series as it is printed: "INV/2026-27/00001", or "CN/" for credit notes. */
function seriesName(prefix: 'INV' | 'CN', taxYear: number, number: number): string {
  const ends = String((taxYear + 1) % 100).padStart(2, '0');
  return `${prefix}/${taxYear}-${ends}/${String(number).padStart(5, '0')}`;
}

/** An invoice's number as it is printed: "INV/2026-27/00001". */
export function invoiceName(taxYear: number, number: number): string {
  return seriesName('INV', taxYear, number);
}

/** A credit note's number as it is printed: "CN/2026-27/00001". */
export function creditNoteName(taxYear: number, number: number): string {
  return seriesName('CN', taxYear, number);
}

/** The next number of a shop's series, taken under its counter's lock in the caller's transaction. */
async function nextNumberIn(
  tx: Tx,
  shopId: string,
  kind: 'invoice' | 'credit_note',
  taxYear: number,
): Promise<number> {
  const { rows } = await tx.execute<{ last_number: number }>(sql`
    INSERT INTO orders.document_counters (shop_id, kind, tax_year, last_number)
    VALUES (${shopId}, ${kind}, ${taxYear}, 1)
    ON CONFLICT (shop_id, kind, tax_year)
      DO UPDATE SET last_number = orders.document_counters.last_number + 1
    RETURNING last_number`);
  return rows[0]!.last_number;
}

/** A shop's series are issued from one transaction at a time, so they have no gaps. */
async function lockSeriesIn(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoices:${shopId}`}, 0))`);
}

type InvoiceRow = { order_id: string; tax_year: number; number: number; issued_at: string | Date };

function toRecord(row: InvoiceRow): OrderInvoiceRecord {
  return {
    orderId: row.order_id,
    taxYear: row.tax_year,
    number: row.number,
    name: invoiceName(row.tax_year, row.number),
    issuedAt: row.issued_at instanceof Date ? row.issued_at : new Date(row.issued_at),
  };
}

/** The invoices issued for orders `orderIds`, by order. */
export async function invoicesIn(
  tx: Tx,
  shopId: string,
  orderIds: readonly string[],
): Promise<Map<string, OrderInvoiceRecord>> {
  if (orderIds.length === 0) return new Map();
  const { rows } = await tx.execute<InvoiceRow>(sql`
    SELECT order_id, tax_year, number, issued_at FROM orders.order_invoices
     WHERE shop_id = ${shopId} AND order_id = ANY(${sql.param([...orderIds])}::uuid[])`);
  return new Map(rows.map((row) => [row.order_id, toRecord(row)]));
}

/**
 * The invoices of orders `orders`, issuing the next numbers, in the order given, to those not
 * cancelled that have none; in the caller's transaction, so numbers come back if it rolls back.
 * A shop's invoices are issued one transaction at a time, so none is numbered twice and no
 * number is skipped. Those issued are kept to report to FBR, while the shop is connected to FBR:
 * from the locations they ship from, in `locations` by ID.
 */
export async function issueInvoicesIn(
  tx: Tx,
  shopId: string,
  orders: readonly OrderRecord[],
  timeZone: string,
  locations: ReadonlyMap<string, LocationRecord> = new Map(),
  now = new Date(),
): Promise<Map<string, OrderInvoiceRecord>> {
  await lockSeriesIn(tx, shopId);
  const invoices = await invoicesIn(
    tx,
    shopId,
    orders.map((order) => order.id),
  );
  const taxYear = taxYearOf(now, timeZone);
  const fiscal: { order: OrderRecord; invoice: OrderInvoiceRecord }[] = [];
  for (const order of orders) {
    if (invoices.has(order.id) || order.stage === 'cancelled') continue;
    const number = await nextNumberIn(tx, shopId, 'invoice', taxYear);
    const { rows: issued } = await tx.execute<InvoiceRow>(sql`
      INSERT INTO orders.order_invoices (shop_id, order_id, tax_year, number, issued_at)
      VALUES (${shopId}, ${order.id}, ${taxYear}, ${number}, ${now.toISOString()})
      RETURNING order_id, tax_year, number, issued_at`);
    const invoice = toRecord(issued[0]!);
    invoices.set(order.id, invoice);
    fiscal.push({ order, invoice });
  }
  if (fiscal.length > 0) {
    const hsCodes = await harmonizedSystemCodesIn(
      tx,
      shopId,
      fiscal.flatMap(({ order }) => order.lines.map((line) => line.variantId)),
    );
    await recordFiscalDocumentsIn(
      tx,
      shopId,
      fiscal.map(({ order, invoice }) =>
        fiscalInvoiceOf(
          order,
          invoice.name,
          invoice.issuedAt,
          hsCodes,
          locations.get(order.locationId) ?? null,
        ),
      ),
      timeZone,
    );
  }
  return invoices;
}

/**
 * A credit note for `refund` of `order`, if the order's invoice was issued: the next number of
 * the shop's credit notes, in the caller's transaction, kept to report to FBR while the shop is
 * connected to FBR. Null if it has no invoice: the invoice says what was refunded before it was
 * printed.
 */
export async function issueCreditNoteIn(
  tx: Tx,
  shopId: string,
  order: Pick<OrderRecord, 'id' | 'taxRate' | 'paymentMethod'>,
  refund: { id: string; amount: bigint; tax: bigint },
  timeZone: string,
  now = new Date(),
): Promise<{ taxYear: number; number: number } | null> {
  // Asked before the series' lock: a print holding it never waits on an order that has its
  // invoice, as the caller's refund holds this one, so the two never wait on each other.
  const invoice = (await invoicesIn(tx, shopId, [order.id])).get(order.id);
  if (!invoice) return null;
  await lockSeriesIn(tx, shopId);
  const taxYear = taxYearOf(now, timeZone);
  const number = await nextNumberIn(tx, shopId, 'credit_note', taxYear);
  await tx.execute(sql`
    INSERT INTO orders.refund_credit_notes (shop_id, refund_id, order_id, tax_year, number,
                                            issued_at)
    VALUES (${shopId}, ${refund.id}, ${order.id}, ${taxYear}, ${number}, ${now.toISOString()})`);
  await recordFiscalDocumentsIn(
    tx,
    shopId,
    [
      fiscalCreditNoteOf(order, {
        usin: creditNoteName(taxYear, number),
        invoiceUsin: invoice.name,
        amount: refund.amount,
        tax: refund.tax,
        issuedAt: now,
      }),
    ],
    timeZone,
  );
  return { taxYear, number };
}

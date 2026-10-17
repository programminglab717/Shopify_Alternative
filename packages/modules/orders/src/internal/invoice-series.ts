import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

// A shop's invoices in a series of their own (TAX-05, ADR-495): numbered from 1 each tax year,
// which in Pakistan starts on 1 July, with no number skipped or given twice. An order's invoice
// takes its number the first time it is printed, and keeps it.

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

/** An invoice's number as it is printed: "INV/2026-27/00001". */
export function invoiceName(taxYear: number, number: number): string {
  const ends = String((taxYear + 1) % 100).padStart(2, '0');
  return `INV/${taxYear}-${ends}/${String(number).padStart(5, '0')}`;
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
 * number is skipped.
 */
export async function issueInvoicesIn(
  tx: Tx,
  shopId: string,
  orders: readonly { id: string; stage: string }[],
  timeZone: string,
  now = new Date(),
): Promise<Map<string, OrderInvoiceRecord>> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoices:${shopId}`}, 0))`);
  const invoices = await invoicesIn(
    tx,
    shopId,
    orders.map((order) => order.id),
  );
  const taxYear = taxYearOf(now, timeZone);
  for (const order of orders) {
    if (invoices.has(order.id) || order.stage === 'cancelled') continue;
    const { rows } = await tx.execute<{ last_number: number }>(sql`
      INSERT INTO orders.document_counters (shop_id, kind, tax_year, last_number)
      VALUES (${shopId}, 'invoice', ${taxYear}, 1)
      ON CONFLICT (shop_id, kind, tax_year)
        DO UPDATE SET last_number = orders.document_counters.last_number + 1
      RETURNING last_number`);
    const { rows: issued } = await tx.execute<InvoiceRow>(sql`
      INSERT INTO orders.order_invoices (shop_id, order_id, tax_year, number, issued_at)
      VALUES (${shopId}, ${order.id}, ${taxYear}, ${rows[0]!.last_number}, ${now.toISOString()})
      RETURNING order_id, tax_year, number, issued_at`);
    invoices.set(order.id, toRecord(issued[0]!));
  }
  return invoices;
}

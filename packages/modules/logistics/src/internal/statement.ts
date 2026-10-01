import { failOne, type MutationResult } from '@hatti/api';
import { CsvError, parseCsv } from '@hatti/csv';
import { fromMajor, MoneyError, type CurrencyCode } from '@hatti/money';
import { trackingKey } from '@hatti/orders/public';

export const STATEMENT_LIMITS = {
  /** Characters in an imported file. */
  csv: 1_500_000,
  rows: 5_000,
  /** Rows an import reports it could not read; it counts them all. */
  rowErrors: 100,
  /** Lines to look into that an import gives back; a statement's lines are read in pages. */
  lines: 250,
} as const;

/**
 * Column names couriers' statements use, matched by {@link headingKey}: TCS, Leopards, PostEx,
 * Trax, M&P and their like, and spreadsheets made from them.
 */
const COLUMNS = {
  tracking: [
    'tracking number',
    'tracking no',
    'tracking id',
    'tracking',
    'track number',
    'track no',
    'cn',
    'cn number',
    'cn no',
    'consignment number',
    'consignment no',
    'consignment',
    'awb',
    'awb number',
    'awb no',
    'booking number',
    'shipment number',
  ],
  collected: [
    'cod amount',
    'cod',
    'cod value',
    'cod collected',
    'collected amount',
    'amount collected',
    'collected',
    'cash collected',
    'invoice amount',
    'invoice payment',
  ],
  charges: [
    'charges',
    'delivery charges',
    'shipping charges',
    'service charges',
    'courier charges',
    'handling charges',
    'freight',
    'freight charges',
    'fee',
    'fees',
  ],
  tax: ['tax', 'wht', 'withholding tax', 'income tax', 'tax withheld', 'sales tax', 'gst'],
  net: [
    'net amount',
    'net payable',
    'net receivable',
    'net paid',
    'net',
    'payable',
    'amount paid',
    'paid amount',
  ],
} as const;

type ColumnKey = keyof typeof COLUMNS;

/** A heading as columns are matched: letters and digits, in lower case, without "Rs" or "PKR". */
export function headingKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== 'rs' && word !== 'pkr')
    .join(' ');
}

/** A line of a courier's statement: a parcel, and the cash the courier collected on it. */
export interface StatementLine {
  /** Its row in the file; the header is row 1. */
  row: number;
  /** As the statement writes it. */
  trackingNumber: string;
  /** As parcels are found by it. */
  key: string;
  /** In minor units, as are the rest. */
  collected: bigint;
  charges: bigint;
  tax: bigint;
  /** What the courier paid over for it, when the statement says. */
  net: bigint | null;
}

/** A row a statement could not be read at, and why. */
export interface StatementRowError {
  row: number;
  /** The column at fault, as the file names it. */
  column: string | null;
  message: string;
}

export interface Statement {
  /** Rows after the header. */
  rows: number;
  lines: StatementLine[];
  /** The first {@link STATEMENT_LIMITS.rowErrors} rows that could not be read. */
  rowErrors: StatementRowError[];
  rowErrorCount: number;
}

/**
 * A courier's remittance statement, from CSV: a row per parcel, found by its tracking number,
 * with the cash collected on it and, when the statement has them, the courier's charges, the
 * tax withheld and what was paid over. Charges and tax count as deductions however the file
 * signs them. A totals row is passed over; rows that cannot be read are reported, and the rest
 * are taken.
 */
export function readStatement(csv: string, currency: CurrencyCode): MutationResult<Statement> {
  if (csv.trim() === '') return failOne(['csv'], 'BLANK', 'The file is empty');
  if (csv.length > STATEMENT_LIMITS.csv) {
    return failOne(
      ['csv'],
      'TOO_LONG',
      `The file can be at most ${STATEMENT_LIMITS.csv.toLocaleString('en')} characters; split it`,
    );
  }
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError) return failOne(['csv'], 'INVALID', error.message);
    throw error;
  }
  const [header = [], ...body] = table;
  if (body.length === 0) return failOne(['csv'], 'BLANK', 'The file has no rows after its header');
  if (body.length > STATEMENT_LIMITS.rows) {
    return failOne(
      ['csv'],
      'TOO_MANY',
      `The file can have at most ${STATEMENT_LIMITS.rows.toLocaleString('en')} parcels; split it`,
    );
  }
  const headings = header.map(headingKey);
  const columns = new Map<ColumnKey, number>();
  for (const [key, names] of Object.entries(COLUMNS) as [ColumnKey, readonly string[]][]) {
    // The first of a column's names the file has, in the order they are listed.
    for (const name of names) {
      const index = headings.indexOf(name);
      if (index >= 0) {
        columns.set(key, index);
        break;
      }
    }
  }
  if (!columns.has('tracking')) {
    return failOne(
      ['csv'],
      'INVALID',
      'The file needs a column of tracking numbers, such as "Tracking Number" or "CN"',
    );
  }
  if (!columns.has('collected')) {
    return failOne(
      ['csv'],
      'INVALID',
      'The file needs a column of the cash collected, such as "COD Amount"',
    );
  }

  const rowErrors: StatementRowError[] = [];
  let rowErrorCount = 0;
  const reject = (row: number, column: ColumnKey | null, message: string) => {
    rowErrorCount += 1;
    if (rowErrors.length < STATEMENT_LIMITS.rowErrors) {
      const index = column === null ? undefined : columns.get(column);
      rowErrors.push({
        row,
        column: index === undefined ? null : (header[index] ?? null),
        message,
      });
    }
  };
  const lines: StatementLine[] = [];
  body.forEach((cells, index) => {
    const row = index + 2;
    const cell = (key: ColumnKey) => {
      const at = columns.get(key);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const trackingNumber = cell('tracking');
    if (trackingNumber === '') {
      // The statement's totals, under its parcels.
      if (cells.some((text) => /^\s*(grand\s+)?totals?\b/i.test(text))) return;
      reject(row, 'tracking', 'The tracking number is missing');
      return;
    }
    if (trackingNumber.length > 100) {
      reject(row, 'tracking', 'The tracking number is longer than 100 characters');
      return;
    }
    const amounts: Partial<Record<'collected' | 'charges' | 'tax' | 'net', bigint | null>> = {};
    for (const key of ['collected', 'charges', 'tax', 'net'] as const) {
      const text = cell(key);
      const amount = amountOf(text, currency);
      if (amount === undefined) {
        reject(row, key, `"${text}" is not an amount`);
        return;
      }
      amounts[key] = amount;
    }
    const collected = amounts.collected ?? 0n;
    if (collected < 0n) {
      reject(row, 'collected', 'The cash collected is less than 0');
      return;
    }
    lines.push({
      row,
      trackingNumber,
      key: trackingKey(trackingNumber),
      collected,
      charges: absolute(amounts.charges ?? 0n),
      tax: absolute(amounts.tax ?? 0n),
      net: amounts.net ?? null,
    });
  });
  return { ok: true, value: { rows: body.length, lines, rowErrors, rowErrorCount } };
}

/**
 * An amount as statements write it, in minor units: "1,250", "Rs. 1,250.50", "PKR 300", or "(150)"
 * for less than 0. Null for an empty cell; undefined for one that is not an amount.
 */
export function amountOf(text: string, currency: CurrencyCode): bigint | null | undefined {
  let plain = text.replace(/\b(rs|pkr)\b\.?/gi, '').replace(/\s/g, '');
  if (plain === '' || plain === '-') return null;
  const bracketed = /^\((.*)\)$/.exec(plain);
  if (bracketed) plain = `-${bracketed[1]}`;
  try {
    return fromMajor(plain, currency).amount;
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

function absolute(amount: bigint): bigint {
  return amount < 0n ? -amount : amount;
}

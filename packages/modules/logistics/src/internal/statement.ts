import { createHash } from 'node:crypto';
import { failOne, type MutationResult } from '@hatti/api';
import { CsvError, parseCsv } from '@hatti/csv';
import { fromMajor, MoneyError, type CurrencyCode } from '@hatti/money';
import { trackingKey } from '@hatti/orders/public';
import { XlsxError, readXlsx, type XlsxValue } from '@hatti/xlsx';

export const STATEMENT_LIMITS = {
  /** Characters in an imported CSV file. */
  csv: 1_500_000,
  /** Bytes in an imported Excel workbook, which comes in base64 in a request of at most 2 MiB. */
  xlsx: 1_400_000,
  rows: 5_000,
  /** Rows above its header a file may have: the courier's name, the account, the period. */
  titleRows: 20,
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
  /** Rows after the header with something in them. */
  rows: number;
  lines: StatementLine[];
  /** The first {@link STATEMENT_LIMITS.rowErrors} rows that could not be read. */
  rowErrors: StatementRowError[];
  rowErrorCount: number;
}

/** The field a statement came in, which its errors are under: CSV, or an Excel workbook. */
export type StatementSource = 'csv' | 'xlsx';

/** A file's row: its number in the file, and its cells' text. */
interface StatementRow {
  row: number;
  cells: readonly string[];
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
  return readRows(
    table.map((cells, index) => ({ row: index + 1, cells })),
    currency,
    'csv',
  );
}

/**
 * A courier's statement from the Excel workbook it came as (ADR-246), in base64 or as a data
 * URL: its first sheet shown, read as a CSV is, its rows by their numbers in the sheet and its
 * numbers as Excel keeps them, so long tracking numbers keep their digits.
 */
export function readStatementWorkbook(
  base64: string,
  currency: CurrencyCode,
): MutationResult<Statement> {
  const encoded = base64.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (encoded === '') return failOne(['xlsx'], 'BLANK', 'The file is empty');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return failOne(['xlsx'], 'INVALID', 'Give the workbook in base64');
  }
  if ((encoded.length / 4) * 3 > STATEMENT_LIMITS.xlsx + 2) {
    return failOne(
      ['xlsx'],
      'TOO_LONG',
      `The workbook can be at most ${(STATEMENT_LIMITS.xlsx / 1_000_000).toLocaleString('en')} MB; ` +
        'split it',
    );
  }
  let sheet: { rows: XlsxValue[][]; more: boolean };
  try {
    sheet = readXlsx(Buffer.from(encoded, 'base64'), {
      maxRows: STATEMENT_LIMITS.titleRows + STATEMENT_LIMITS.rows + 1,
      maxColumns: 200,
    });
  } catch (error) {
    if (error instanceof XlsxError) return failOne(['xlsx'], 'INVALID', error.message);
    throw error;
  }
  if (sheet.more) return tooMany('xlsx');
  return readRows(
    sheet.rows.map((cells, index) => ({ row: index + 1, cells: cells.map(cellText) })),
    currency,
    'xlsx',
  );
}

/** A workbook's cell as a CSV would have it, a number to the 15 digits Excel keeps. */
function cellText(value: XlsxValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  return value;
}

function tooMany(source: StatementSource): MutationResult<Statement> {
  return failOne(
    [source],
    'TOO_MANY',
    `The file can have at most ${STATEMENT_LIMITS.rows.toLocaleString('en')} parcels; split it`,
  );
}

/** The columns a statement's header names, each by the first of its names the header has. */
function columnsOf(header: readonly string[]): Map<ColumnKey, number> {
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
  return columns;
}

/**
 * A statement's lines from its file's rows: under its header, the first row that names a column
 * of tracking numbers, so that a courier's title rows above it are passed over; rows with
 * nothing in them are passed over wherever they are.
 */
function readRows(
  all: readonly StatementRow[],
  currency: CurrencyCode,
  source: StatementSource,
): MutationResult<Statement> {
  const rows = all.filter((each) => each.cells.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) return failOne([source], 'BLANK', 'The file is empty');
  const at = rows
    .slice(0, STATEMENT_LIMITS.titleRows + 1)
    .findIndex((each) => columnsOf(each.cells).has('tracking'));
  if (at < 0) {
    return failOne(
      [source],
      'INVALID',
      'The file needs a column of tracking numbers, such as "Tracking Number" or "CN"',
    );
  }
  const header = rows[at]!.cells;
  const body = rows.slice(at + 1);
  if (body.length === 0) {
    return failOne([source], 'BLANK', 'The file has no rows after its header');
  }
  if (body.length > STATEMENT_LIMITS.rows) return tooMany(source);
  const columns = columnsOf(header);
  if (!columns.has('collected')) {
    return failOne(
      [source],
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
  for (const { row, cells } of body) {
    const cell = (key: ColumnKey) => {
      const index = columns.get(key);
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const trackingNumber = cell('tracking');
    if (trackingNumber === '') {
      // The statement's totals, under its parcels.
      if (cells.some((text) => /^\s*(grand\s+)?totals?\b/i.test(text))) continue;
      reject(row, 'tracking', 'The tracking number is missing');
      continue;
    }
    if (trackingNumber.length > 100) {
      reject(row, 'tracking', 'The tracking number is longer than 100 characters');
      continue;
    }
    // Excel writes a long number it shows as 1.23457E+11 so in a CSV, its digits gone.
    if (/^\d(\.\d+)?E\+\d+$/i.test(trackingNumber)) {
      reject(
        row,
        'tracking',
        `"${trackingNumber}" is a tracking number Excel shortened: import the courier's Excel ` +
          'file itself, not a CSV saved from it',
      );
      continue;
    }
    const amounts: Partial<Record<'collected' | 'charges' | 'tax' | 'net', bigint | null>> = {};
    let readable = true;
    for (const key of ['collected', 'charges', 'tax', 'net'] as const) {
      const text = cell(key);
      const amount = amountOf(text, currency);
      if (amount === undefined) {
        reject(row, key, `"${text}" is not an amount`);
        readable = false;
        break;
      }
      amounts[key] = amount;
    }
    if (!readable) continue;
    const collected = amounts.collected ?? 0n;
    if (collected < 0n) {
      reject(row, 'collected', 'The cash collected is less than 0');
      continue;
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
  }
  return { ok: true, value: { rows: body.length, lines, rowErrors, rowErrorCount } };
}

/**
 * SHA-256 of a statement's lines as read, in any order (ADR-088): the same statement has the same
 * one however it was saved, sorted or spaced, and whatever its columns are called.
 */
export function digestOf(lines: readonly StatementLine[]): Buffer {
  const read = lines
    .map((line) =>
      JSON.stringify([
        line.key,
        `${line.collected}`,
        `${line.charges}`,
        `${line.tax}`,
        line.net === null ? null : `${line.net}`,
      ]),
    )
    .sort();
  return createHash('sha256').update(read.join('\n')).digest();
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

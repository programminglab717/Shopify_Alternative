import { failOne, type MutationResult } from '@hatti/api';
import { CsvError, parseCsv } from '@hatti/csv';
import { fromMajor, MoneyError, type CurrencyCode } from '@hatti/money';
import { XlsxError, readXlsx, type XlsxValue } from '@hatti/xlsx';

// Gateways' settlement statements (PAY-07, ADR-491), as CSV or the Excel workbooks gateways send:
// a row per payment they paid over, found by their reference for it, with what the customer paid
// and, where the statement has them, the gateway's fees, the tax it withheld and what it paid.

export const SETTLEMENT_LIMITS = {
  /** Characters in an imported CSV file. */
  csv: 1_500_000,
  /** Bytes in an imported Excel workbook, which comes in base64 in a request of at most 2 MiB. */
  xlsx: 1_400_000,
  rows: 5_000,
  /** Rows above its header a file may have: the gateway's name, the merchant, the period. */
  titleRows: 20,
  /** Rows an import reports it could not read; it counts them all. */
  rowErrors: 100,
  /** Lines to look into that an import gives back; a settlement's lines are read in pages. */
  lines: 250,
} as const;

/**
 * Column names gateways' statements use, matched by {@link headingKey}: Safepay, JazzCash,
 * Easypaisa, PayFast, HBL, Bank Alfalah and spreadsheets made from them.
 */
const COLUMNS = {
  reference: [
    'transaction reference',
    'transaction ref',
    'transaction ref no',
    'transaction reference number',
    'transaction id',
    'transaction no',
    'txn reference',
    'txn ref',
    'txn ref no',
    'txn id',
    'pp txnrefno',
    'tracker',
    'payment id',
    'payment reference',
    'order id',
    'order reference',
    'basket id',
    'reference',
    'reference no',
  ],
  gross: [
    'gross amount',
    'transaction amount',
    'txn amount',
    'amount',
    'gross',
    'paid amount',
    'order amount',
  ],
  fees: [
    'fee',
    'fees',
    'mdr',
    'mdr amount',
    'commission',
    'processing fee',
    'service charges',
    'charges',
    'gateway fee',
  ],
  tax: [
    'tax',
    'wht',
    'withholding tax',
    'income tax',
    'tax deducted',
    'tax withheld',
    'fed',
    'sst',
    'gst',
    'sales tax',
  ],
  net: [
    'net amount',
    'net',
    'net payable',
    'settled amount',
    'settlement amount',
    'amount settled',
    'payable',
    'net settlement',
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

/** A line of a gateway's statement: a payment, and what was paid and deducted on it. */
export interface SettlementStatementLine {
  /** Its row in the file; the header is row 1 or below. */
  row: number;
  /** The gateway's reference for the payment, as the statement writes it. */
  reference: string;
  /** In minor units, as are the rest; less than 0 for a refund the gateway took back. */
  gross: bigint;
  fees: bigint;
  tax: bigint;
  /** What the gateway paid over for it, where the statement says. */
  net: bigint | null;
}

export interface SettlementRowError {
  row: number;
  /** The column at fault, as the file names it. */
  column: string | null;
  message: string;
}

export interface SettlementStatement {
  /** Rows after the header with something in them. */
  rows: number;
  lines: SettlementStatementLine[];
  rowErrors: SettlementRowError[];
  rowErrorCount: number;
}

export type SettlementSource = 'csv' | 'xlsx';

/** A gateway's settlement statement from CSV. */
export function readSettlement(
  csv: string,
  currency: CurrencyCode,
): MutationResult<SettlementStatement> {
  if (csv.trim() === '') return failOne(['csv'], 'BLANK', 'The file is empty');
  if (csv.length > SETTLEMENT_LIMITS.csv) {
    return failOne(
      ['csv'],
      'TOO_LONG',
      `The file can be at most ${SETTLEMENT_LIMITS.csv.toLocaleString('en')} characters; split it`,
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

/** A gateway's settlement statement from the Excel workbook it came as, in base64. */
export function readSettlementWorkbook(
  base64: string,
  currency: CurrencyCode,
): MutationResult<SettlementStatement> {
  const encoded = base64.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (encoded === '') return failOne(['xlsx'], 'BLANK', 'The file is empty');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return failOne(['xlsx'], 'INVALID', 'Give the workbook in base64');
  }
  if ((encoded.length / 4) * 3 > SETTLEMENT_LIMITS.xlsx + 2) {
    return failOne(['xlsx'], 'TOO_LONG', 'The workbook can be at most 1.4 MB; split it');
  }
  let sheet: { rows: XlsxValue[][]; more: boolean };
  try {
    sheet = readXlsx(Buffer.from(encoded, 'base64'), {
      maxRows: SETTLEMENT_LIMITS.titleRows + SETTLEMENT_LIMITS.rows + 1,
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

function cellText(value: XlsxValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  return value;
}

function tooMany(source: SettlementSource): MutationResult<SettlementStatement> {
  return failOne(
    [source],
    'TOO_MANY',
    `The file can have at most ${SETTLEMENT_LIMITS.rows.toLocaleString('en')} payments; split it`,
  );
}

function columnsOf(header: readonly string[]): Map<ColumnKey, number> {
  const headings = header.map(headingKey);
  const columns = new Map<ColumnKey, number>();
  for (const [key, names] of Object.entries(COLUMNS) as [ColumnKey, readonly string[]][]) {
    for (const name of names) {
      const index = headings.indexOf(name);
      if (index >= 0 && ![...columns.values()].includes(index)) {
        columns.set(key, index);
        break;
      }
    }
  }
  return columns;
}

function readRows(
  all: readonly { row: number; cells: readonly string[] }[],
  currency: CurrencyCode,
  source: SettlementSource,
): MutationResult<SettlementStatement> {
  const rows = all.filter((each) => each.cells.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) return failOne([source], 'BLANK', 'The file is empty');
  const at = rows
    .slice(0, SETTLEMENT_LIMITS.titleRows + 1)
    .findIndex((each) => columnsOf(each.cells).has('reference'));
  if (at < 0) {
    return failOne(
      [source],
      'INVALID',
      'The file needs a column of the gateway\'s references, such as "Transaction ID"',
    );
  }
  const header = rows[at]!.cells;
  const body = rows.slice(at + 1);
  if (body.length === 0) return failOne([source], 'BLANK', 'The file has no rows after its header');
  if (body.length > SETTLEMENT_LIMITS.rows) return tooMany(source);
  const columns = columnsOf(header);
  if (!columns.has('gross')) {
    return failOne(
      [source],
      'INVALID',
      'The file needs a column of what customers paid, such as "Amount"',
    );
  }

  const rowErrors: SettlementRowError[] = [];
  let rowErrorCount = 0;
  const reject = (row: number, column: ColumnKey, message: string) => {
    rowErrorCount += 1;
    if (rowErrors.length < SETTLEMENT_LIMITS.rowErrors) {
      const index = columns.get(column);
      rowErrors.push({
        row,
        column: index === undefined ? null : (header[index] ?? null),
        message,
      });
    }
  };
  const lines: SettlementStatementLine[] = [];
  for (const { row, cells } of body) {
    const cell = (key: ColumnKey) => {
      const index = columns.get(key);
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const reference = cell('reference');
    if (reference === '') {
      // The statement's totals, under its payments.
      if (cells.some((text) => /^\s*(grand\s+)?totals?\b/i.test(text))) continue;
      reject(row, 'reference', "The gateway's reference is missing");
      continue;
    }
    // The statement's totals, under its payments, named in the reference's column.
    if (/^(grand\s+)?totals?\b/i.test(reference)) continue;
    if (reference.length > 200) {
      reject(row, 'reference', 'The reference is longer than 200 characters');
      continue;
    }
    const amounts: Partial<Record<'gross' | 'fees' | 'tax' | 'net', bigint | null>> = {};
    let readable = true;
    for (const key of ['gross', 'fees', 'tax', 'net'] as const) {
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
    if (amounts.gross === null || amounts.gross === undefined) {
      reject(row, 'gross', 'What the customer paid is missing');
      continue;
    }
    lines.push({
      row,
      reference,
      gross: amounts.gross,
      fees: absolute(amounts.fees ?? 0n),
      tax: absolute(amounts.tax ?? 0n),
      net: amounts.net ?? null,
    });
  }
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

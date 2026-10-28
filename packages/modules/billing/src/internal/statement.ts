import { parseCsv } from '@hatti/csv';

// Hatti's bank statement, matched against the transfers shops said they made into Hatti's account
// (ADR-254, ADR-883): its credits read from the CSV the bank exports, and each paired with the
// waiting transfer whose reference it carries, for Hatti's people to confirm. Banks name their
// columns their own ways; the usual names are looked for in the first rows, the header being the
// first row that names a credit column and a date or description column. Nothing is confirmed
// here: Hatti's people confirm each match, for what came.

export const STATEMENT_LIMITS = {
  /** Rows of a statement read, its header among them. */
  rows: 20_000,
  /** Rows looked through for the header, past a bank's own lines before it. */
  headerSearch: 30,
  /** A reference shorter than this is too likely to turn up in another line by chance. */
  shortestReference: 4,
} as const;

/** A credit into Hatti's account, as the statement gives it. */
export interface StatementCredit {
  /** Its row among the statement's rows, from 1, blank lines not counted. */
  row: number;
  date: string | null;
  description: string;
  /** Paisa. */
  amount: bigint;
}

/** A waiting transfer, as the matcher needs it. */
export interface TransferToMatch {
  id: string;
  /** As the shop's owner gave it. */
  reference: string;
  /** Paisa: what the invoice asked for. */
  amount: bigint;
}

export interface StatementMatch {
  transferId: string;
  credit: StatementCredit;
  /** The credit is what was said, less, or more. */
  outcome: 'exact' | 'short' | 'over';
}

export interface StatementResult {
  credits: number;
  matches: StatementMatch[];
  /** Transfers whose reference more than one credit carries: for Hatti's people to look at. */
  ambiguous: string[];
  /** Credits no waiting transfer's reference is in. */
  unmatched: StatementCredit[];
}

export class StatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementError';
  }
}

const COLUMNS = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'booking date'],
  description: [
    'description',
    'narration',
    'particulars',
    'details',
    'transaction details',
    'remarks',
    'transaction description',
  ],
  reference: [
    'reference',
    'ref',
    'ref no',
    'reference no',
    'reference number',
    'instrument no',
    'cheque no',
    'transaction id',
    'stan',
  ],
  credit: [
    'credit',
    'credits',
    'deposit',
    'deposits',
    'cr',
    'credit amount',
    'amount credited',
    'credit (pkr)',
    'deposit amount',
  ],
} as const;

const label = (cell: string) =>
  cell.trim().toLowerCase().replace(/[.:#]/g, '').replace(/\s+/g, ' ');

/** Letters and digits alone, upper case: how references are compared. */
export const referenceKey = (text: string) => text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Rupees as banks write them, "2,999.00" or "2999", as paisa; null for anything else. */
function paisaOf(cell: string): bigint | null {
  const text = cell
    .trim()
    .replace(/,/g, '')
    .replace(/^(PKR|Rs\.?)\s*/i, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/** The credits of a bank's statement, as CSV. */
export function statementCredits(csv: string): StatementCredit[] {
  let rows: string[][];
  try {
    rows = parseCsv(csv);
  } catch (error) {
    throw new StatementError(`The statement isn't CSV Hatti can read: ${(error as Error).message}`);
  }
  if (rows.length > STATEMENT_LIMITS.rows) {
    throw new StatementError(`A statement is read ${STATEMENT_LIMITS.rows} rows at most: split it`);
  }
  const find = (cells: string[], names: readonly string[]) =>
    cells.findIndex((cell) => (names as readonly string[]).includes(label(cell)));
  let headerAt = -1;
  let at = { date: -1, description: -1, reference: -1, credit: -1 };
  for (let index = 0; index < Math.min(rows.length, STATEMENT_LIMITS.headerSearch); index++) {
    const cells = rows[index]!;
    const found = {
      date: find(cells, COLUMNS.date),
      description: find(cells, COLUMNS.description),
      reference: find(cells, COLUMNS.reference),
      credit: find(cells, COLUMNS.credit),
    };
    if (found.credit >= 0 && (found.description >= 0 || found.reference >= 0)) {
      headerAt = index;
      at = found;
      break;
    }
  }
  if (headerAt < 0) {
    throw new StatementError(
      'No column of credits, with a description or reference beside it, was found: export the ' +
        'statement with its headings',
    );
  }
  const credits: StatementCredit[] = [];
  for (let index = headerAt + 1; index < rows.length; index++) {
    const cells = rows[index]!;
    const amount = paisaOf(cells[at.credit] ?? '');
    if (amount === null || amount <= 0n) continue;
    const description = [
      at.description >= 0 ? cells[at.description] : '',
      at.reference >= 0 ? cells[at.reference] : '',
    ]
      .map((cell) => (cell ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    credits.push({
      row: index + 1,
      date: at.date >= 0 ? cells[at.date]?.trim() || null : null,
      description,
      amount,
    });
  }
  return credits;
}

/**
 * The statement's credits paired with the waiting transfers whose references they carry, each
 * credit and each transfer once. A transfer whose reference two credits carry is left for Hatti's
 * people, and so is a reference too short to tell apart.
 */
export function matchStatement(
  csv: string,
  transfers: readonly TransferToMatch[],
): StatementResult {
  const credits = statementCredits(csv);
  const used = new Set<number>();
  const matches: StatementMatch[] = [];
  const ambiguous: string[] = [];
  for (const transfer of transfers) {
    const key = referenceKey(transfer.reference);
    if (key.length < STATEMENT_LIMITS.shortestReference) continue;
    const carrying = credits.filter(
      (credit) => !used.has(credit.row) && referenceKey(credit.description).includes(key),
    );
    if (carrying.length > 1) {
      ambiguous.push(transfer.id);
      continue;
    }
    const credit = carrying[0];
    if (!credit) continue;
    used.add(credit.row);
    matches.push({
      transferId: transfer.id,
      credit,
      outcome:
        credit.amount === transfer.amount
          ? 'exact'
          : credit.amount < transfer.amount
            ? 'short'
            : 'over',
    });
  }
  return {
    credits: credits.length,
    matches,
    ambiguous,
    unmatched: credits.filter((credit) => !used.has(credit.row)),
  };
}

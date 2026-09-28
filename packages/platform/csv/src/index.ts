/**
 * CSV for imports and exports (RFC 4180): fields separated by commas, quoted with double quotes
 * when they hold a comma, a quote or a line break, and a quote inside a quoted field doubled.
 */

/** A file that is not valid CSV. `line` counts from 1. */
export class CsvError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
  ) {
    super(`${reason} (line ${line})`);
    this.name = 'CsvError';
  }
}

const BOM = '\uFEFF';

/**
 * Rows of cells. A byte-order mark at the start is dropped, as Excel writes one; lines may end in
 * CRLF, LF or CR; blank lines are skipped. Throws a {@link CsvError} for a quote left open.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  // A row made only of one empty cell is a blank line.
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    cell = '';
  };
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (source.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n' || (char === '\r' && source.charAt(index + 1) !== '\n')) line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      quoteLine = line;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source.charAt(index + 1) === '\n') index += 1;
      endRow();
      line += 1;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CsvError('A quoted cell is never closed', quoteLine);
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface CsvWriteOptions {
  /**
   * Start with a byte-order mark, so Excel reads the file as UTF-8 and shows Urdu correctly.
   * Default true.
   */
  bom?: boolean;
}

/**
 * Cells a spreadsheet would run as a formula start with these; such cells get a leading
 * apostrophe, which spreadsheets show as text (CSV injection).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const safe = typeof value === 'string' && FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV text for rows of cells, with CRLF line endings. Text cells that would start a formula get
 * a leading apostrophe; numbers are written as they are.
 */
export function toCsv(
  rows: readonly (readonly (string | number | null | undefined)[])[],
  options: CsvWriteOptions = {},
): string {
  const body = rows.map((row) => row.map(cellText).join(',')).join('\r\n');
  return ((options.bom ?? true) ? BOM : '') + body + (rows.length > 0 ? '\r\n' : '');
}

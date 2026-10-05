import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Excel workbooks of one sheet for exports (Office Open XML, ECMA-376): cells kept as text,
 * numbers, amounts or times, as their columns say, under a bold header that stays in view with
 * a filter on it, each column as wide as its contents. Text is written as text, never as a
 * formula, so a cell that begins with "=" cannot run in a spreadsheet; characters XML cannot
 * carry are left out. The workbook is a ZIP of its parts, deflated with Node's own zlib.
 */

/**
 * How a column's cells are kept: as text; as a number; as an amount, a number shown with two
 * places and thousands apart; or as a time, "2026-09-29 01:30", which spreadsheets sort and
 * filter as one. A cell its column cannot read so stays text.
 */
export type XlsxColumnType = 'text' | 'number' | 'amount' | 'time';

export interface XlsxColumn {
  header: string;
  /** Text unless said. */
  type?: XlsxColumnType;
}

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  /** The sheet's tab: up to 31 characters, any of \ / ? * [ ] : left out. */
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly (readonly XlsxCell[])[];
}

/** What a sheet holds at most, as Excel opens it. */
export const XLSX_LIMITS = {
  rows: 1_048_576,
  columns: 16_384,
  /** Characters a cell holds. */
  cell: 32_767,
} as const;

/** A workbook's type, as a download or an email's attachment names it. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The workbook of `sheet`, ready to save as a .xlsx file. */
export function toXlsx(sheet: XlsxSheet): Buffer {
  const { columns, rows } = sheet;
  if (columns.length === 0 || columns.length > XLSX_LIMITS.columns) {
    throw new RangeError(`A sheet has 1 to ${XLSX_LIMITS.columns} columns`);
  }
  if (rows.length + 1 > XLSX_LIMITS.rows) {
    throw new RangeError(`A sheet has at most ${XLSX_LIMITS.rows - 1} rows under its header`);
  }
  const name = sheetName(sheet.name);
  const lastColumn = columnName(columns.length - 1);
  const lastRow = rows.length + 1;
  const parts: [string, string][] = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELATIONSHIPS],
    ['xl/workbook.xml', workbook(name, `$A$1:$${lastColumn}$${lastRow}`)],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELATIONSHIPS],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', worksheet(columns, rows, `A1:${lastColumn}${lastRow}`)],
  ];
  return zip(parts.map(([path, xml]) => ({ path, data: Buffer.from(xml, 'utf8') })));
}

/** Its cells' styles, by their place in styles.xml's cellXfs. */
const STYLE = { header: 1, amount: 2, time: 3 } as const;

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CONTENT_TYPES =
  XML +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELATIONSHIPS =
  XML +
  `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELATIONSHIPS =
  XML +
  `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
  '</Relationships>';

// Calibri, as Excel's own workbooks are; the header bold; amounts "#,##0.00" and times
// "yyyy-mm-dd hh:mm", as the CSV writes them.
const STYLES =
  XML +
  `<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="2">' +
  '<numFmt numFmtId="164" formatCode="#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/>' +
  '</numFmts>' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function workbook(name: string, filtered: string): string {
  const quoted = `'${name.replace(/'/g, "''")}'`;
  return (
    XML +
    `<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
    `<sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    // Excel's own name for the range its filter covers, as it writes it.
    '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
    `${escapeXml(`${quoted}!${filtered}`)}</definedName></definedNames>` +
    '</workbook>'
  );
}

function worksheet(
  columns: readonly XlsxColumn[],
  rows: readonly (readonly XlsxCell[])[],
  filtered: string,
): string {
  const widths = columns.map((column) => column.header.length);
  const body: string[] = [];
  body.push(
    '<row r="1">' +
      columns
        .map((column, index) => textCell(`${columnName(index)}1`, column.header, STYLE.header))
        .join('') +
      '</row>',
  );
  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    let cells = '';
    columns.forEach((column, index) => {
      const value = row[index];
      if (value === null || value === undefined || value === '') return;
      const written = cell(`${columnName(index)}${r}`, value, column.type ?? 'text');
      widths[index] = Math.max(widths[index]!, written.width);
      cells += written.xml;
    });
    body.push(`<row r="${r}">${cells}</row>`);
  });
  return (
    XML +
    `<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
    // The header stays in view as the rows scroll under it.
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols>' +
    widths
      .map(
        (width, index) =>
          `<col min="${index + 1}" max="${index + 1}" ` +
          `width="${Math.min(60, Math.max(8, width + 2))}" customWidth="1"/>`,
      )
      .join('') +
    '</cols>' +
    `<sheetData>${body.join('')}</sheetData>` +
    `<autoFilter ref="${filtered}"/>` +
    '</worksheet>'
  );
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A cell as its column keeps it, and how wide it shows. */
function cell(ref: string, value: string | number, type: XlsxColumnType): XlsxWritten {
  if (type === 'number' || type === 'amount') {
    const number =
      typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
    if (NUMBER.test(number)) {
      const style = type === 'amount' ? ` s="${STYLE.amount}"` : '';
      // Shown with its thousands apart, and two places for an amount.
      const width = number.length + Math.floor(number.split('.')[0]!.length / 3) + 3;
      return { xml: `<c r="${ref}"${style}><v>${number}</v></c>`, width };
    }
  } else if (type === 'time' && typeof value === 'string') {
    const serial = timeSerial(value);
    if (serial !== null) {
      return { xml: `<c r="${ref}" s="${STYLE.time}"><v>${serial}</v></c>`, width: 16 };
    }
  }
  const text = String(value);
  return { xml: textCell(ref, text), width: Math.min(text.length, 60) };
}

interface XlsxWritten {
  xml: string;
  width: number;
}

/** Text kept as it is, never read as a number or a formula. */
function textCell(ref: string, text: string, style = 0): string {
  const kept = xmlText(text).slice(0, XLSX_LIMITS.cell);
  return (
    `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXml(kept)}</t></is></c>`
  );
}

/**
 * "2026-09-29 01:30" as Excel keeps a time: days since 30 December 1899, the fraction the time
 * of day; null for what is not a time.
 */
function timeSerial(value: string): number | null {
  const match = TIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const at = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const date = new Date(at);
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59;
  return valid ? (at - Date.UTC(1899, 11, 30)) / 86_400_000 : null;
}

/** "A" for the first column, "Z" for the 26th, "AA" for the 27th. */
export function columnName(index: number): string {
  let name = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/** A tab's name as Excel takes it. */
function sheetName(name: string): string {
  const kept = name
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return kept || 'Sheet1';
}

/**
 * `text` without what XML 1.0 cannot carry: control characters other than tab, line feed and
 * carriage return, and the two non-characters U+FFFE and U+FFFF. Lone surrogates become U+FFFD
 * as the text is written in UTF-8.
 */
function xmlText(text: string): string {
  let kept = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const allowed =
      code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code < 0xfffe);
    if (allowed) kept += text.charAt(index);
  }
  return kept;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1 January 1980, midnight: the earliest a ZIP's entries can say, the same each time. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

/** A ZIP of `files`, each deflated (PKWARE's APPNOTE, without ZIP64: a workbook is far smaller). */
function zip(files: readonly { path: string; data: Buffer }[]): Buffer {
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const path = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(file.data);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);
    entries.push(local, path, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(path.length, 28);
    // Extra field, comment, disk, internal and external attributes: none.
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);
    offset += local.length + path.length + deflated.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...directory, end]);
}

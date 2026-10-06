import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Workbooks people send (Office Open XML, ECMA-376), as Excel, Google Sheets and LibreOffice save
 * them: the cells of the first sheet shown, as text, numbers or true and false, whether kept as
 * shared or inline strings. The ZIP is read from its central directory, and each part inflated
 * within a size the caller trusts, so a small file cannot unpack into a large one. Excel 97-2003
 * workbooks (.xls), and workbooks with a password, which are not ZIPs, are told apart and refused.
 */

/** A cell as read: its text, its number as kept, a boolean's value, or null when empty. */
export type XlsxValue = string | number | boolean | null;

/** A file that cannot be read as a workbook, saying why in words for whoever sent it. */
export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxReadOptions {
  /** The most a part of the workbook may unpack to, in bytes: 32 MiB unless said. */
  maxPartBytes?: number;
  /** Rows past this one are not kept: `more` says whether any had something in them. */
  maxRows?: number;
  /** Cells past this column are not kept. */
  maxColumns?: number;
}

export interface XlsxRead {
  /** The sheet's name, as its tab shows it. */
  sheet: string;
  /** Its rows by their numbers, the first at 0, each cell at its column's place; empty for none. */
  rows: XlsxValue[][];
  /** Whether rows past `maxRows` had something in them. */
  more: boolean;
}

const NOT_A_WORKBOOK = 'Not an Excel workbook (.xlsx)';
const DAMAGED = 'The workbook is damaged: save it again in Excel, or as CSV';
const TOO_LARGE = 'The workbook is too large to read: split it';
const OLD_OR_LOCKED =
  'An Excel 97-2003 workbook (.xls), or one with a password, cannot be read: save it as an ' +
  'Excel workbook (.xlsx) without a password, or as CSV';

/** The first bytes of an OLE compound file: Excel 97-2003, and the envelope of a locked workbook. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The first sheet shown of the workbook `file`; throws an {@link XlsxError} for what is not one. */
export function readXlsx(file: Uint8Array, options: XlsxReadOptions = {}): XlsxRead {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (OLE.every((byte, index) => bytes[index] === byte)) throw new XlsxError(OLD_OR_LOCKED);
  const zip = new Zip(bytes, options.maxPartBytes ?? 32 * 1024 * 1024);

  // The workbook, where the package's relationships say, and its own relationships beside it.
  const root = relationships(zip.text('_rels/.rels') ?? '', '');
  const workbookPath =
    root.find((each) => each.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const workbook = zip.text(workbookPath);
  if (workbook === null) throw new XlsxError(NOT_A_WORKBOOK);
  const folder = workbookPath.includes('/')
    ? workbookPath.slice(0, workbookPath.lastIndexOf('/'))
    : '';
  const name = workbookPath.slice(folder.length === 0 ? 0 : folder.length + 1);
  const linked = relationships(
    zip.text(`${folder ? `${folder}/` : ''}_rels/${name}.rels`) ?? '',
    folder,
  );

  const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)].map(([, attributes]) => {
    const values = attributesOf(attributes!);
    const id = [...values].find(([key]) => key === 'id' || key.endsWith(':id'))?.[1];
    return {
      name: unescapeXml(values.get('name') ?? ''),
      hidden: values.get('state') === 'hidden' || values.get('state') === 'veryHidden',
      target: linked.find((each) => each.id === id)?.target ?? null,
    };
  });
  const sheet = sheets.find((each) => !each.hidden) ?? sheets[0];
  const xml = sheet?.target ? zip.text(sheet.target) : null;
  if (!sheet || xml === null) throw new XlsxError('The workbook has no sheet to read');

  const stringsPath =
    linked.find((each) => each.type.endsWith('/sharedStrings'))?.target ??
    `${folder ? `${folder}/` : ''}sharedStrings.xml`;
  // Each string in its place, an empty one written <si/> too.
  const shared = [
    ...(zip.text(stringsPath) ?? '').matchAll(
      /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g,
    ),
  ].map(([, content]) => textOf(content ?? ''));
  return { sheet: sheet.name, ...rowsOf(xml, shared, options) };
}

/** A sheet's rows, by their numbers, as far as `options` say. */
function rowsOf(
  xml: string,
  shared: readonly string[],
  options: XlsxReadOptions,
): { rows: XlsxValue[][]; more: boolean } {
  const maxRows = options.maxRows ?? 100_000;
  const maxColumns = options.maxColumns ?? 1_000;
  const rows: XlsxValue[][] = [];
  let more = false;
  let previous = 0;
  for (const [, attributes, , content] of xml.matchAll(
    /<(?:\w+:)?row\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g,
  )) {
    const number = Number(attributesOf(attributes!).get('r') ?? previous + 1);
    if (!Number.isSafeInteger(number) || number <= previous) throw new XlsxError(DAMAGED);
    previous = number;
    const cells: XlsxValue[] = [];
    let column = 0;
    for (const [, cellAttributes, , inside] of (content ?? '').matchAll(
      /<(?:\w+:)?c\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g,
    )) {
      const values = attributesOf(cellAttributes!);
      const ref = values.get('r');
      column = ref ? columnIndex(ref) : column + 1;
      if (column > maxColumns) continue;
      const value = valueOf(values.get('t') ?? 'n', inside ?? '', shared);
      if (value === null) continue;
      while (cells.length < column - 1) cells.push(null);
      cells[column - 1] = value;
    }
    if (cells.length === 0) continue;
    if (number > maxRows) {
      more = true;
      break;
    }
    rows[number - 1] = cells;
  }
  return { rows: Array.from(rows, (row) => row ?? []), more };
}

/** A cell's value, by its type: a shared string, an inline one, a formula's text, and so on. */
function valueOf(type: string, inside: string, shared: readonly string[]): XlsxValue {
  if (type === 'inlineStr') {
    const inline = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inside)?.[1];
    return inline === undefined ? null : textOf(inline);
  }
  const kept = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inside)?.[1];
  if (kept === undefined) return null;
  if (type === 's') return shared[Number(kept)] ?? '';
  if (type === 'b') return kept.trim() === '1';
  // A formula's text, an error such as #N/A, or a time written out.
  if (type === 'str' || type === 'e' || type === 'd') return unescapeXml(kept);
  const number = Number(kept);
  return kept.trim() === '' ? null : Number.isFinite(number) ? number : unescapeXml(kept);
}

/** A string's text: its runs together, without the readings some languages add above them. */
function textOf(content: string): string {
  const plain = content.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let text = '';
  for (const [, run] of plain.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    text += unescapeXml(run!);
  }
  // Characters XML cannot carry, as Excel writes them: _x000D_ for a carriage return.
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** "AB12" is column 28. */
function columnIndex(ref: string): number {
  const letters = /^([A-Za-z]{1,3})\d*$/.exec(ref)?.[1];
  if (!letters) throw new XlsxError(DAMAGED);
  return [...letters.toUpperCase()].reduce(
    (sum, letter) => sum * 26 + letter.charCodeAt(0) - 64,
    0,
  );
}

interface Relationship {
  id: string;
  type: string;
  /** The part's path in the ZIP. */
  target: string;
}

/** A part's relationships, their targets as paths in the ZIP from the part's `folder`. */
function relationships(xml: string, folder: string): Relationship[] {
  return [...xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)].map(([, attributes]) => {
    const values = attributesOf(attributes!);
    return {
      id: values.get('Id') ?? '',
      type: values.get('Type') ?? '',
      target: pathFrom(folder, unescapeXml(values.get('Target') ?? '')),
    };
  });
}

/** `target` as a path in the ZIP: from its root when it starts with "/", else from `folder`. */
function pathFrom(folder: string, target: string): string {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function attributesOf(text: string): Map<string, string> {
  return new Map(
    [...text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
      ([, key, double, single]) => [key!, double ?? single ?? ''],
    ),
  );
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, (whole, entity: string) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'amp') return '&';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** A ZIP's entries, by their names, as its central directory gives them (PKWARE's APPNOTE). */
class Zip {
  readonly #entries = new Map<
    string,
    { method: number; crc: number; packed: number; size: number; offset: number }
  >();

  constructor(
    private readonly bytes: Buffer,
    private readonly maxPartBytes: number,
  ) {
    // Its end record: 22 bytes, then a comment of at most 65,535.
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
      if (bytes.readUInt32LE(at) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new XlsxError(NOT_A_WORKBOOK);
    const count = this.#u16(end + 10);
    let at = this.#u32(end + 16);
    // A ZIP64 workbook, of more than 65,535 parts or 4 GiB: far past what is read here.
    if (count === 0xffff || at === 0xffffffff) throw new XlsxError(TOO_LARGE);
    for (let index = 0; index < count; index++) {
      if (this.#u32(at) !== 0x02014b50) throw new XlsxError(DAMAGED);
      const flags = this.#u16(at + 8);
      // Encrypted the old way: Excel's own passwords are not in ZIPs at all.
      if (flags & 1) throw new XlsxError(OLD_OR_LOCKED);
      const nameLength = this.#u16(at + 28);
      const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      this.#entries.set(name.replace(/^\/+/, ''), {
        method: this.#u16(at + 10),
        crc: this.#u32(at + 16),
        packed: this.#u32(at + 20),
        size: this.#u32(at + 24),
        offset: this.#u32(at + 42),
      });
      at += 46 + nameLength + this.#u16(at + 30) + this.#u16(at + 32);
    }
  }

  /** A part's text; null when the ZIP has no part by the name. */
  text(name: string): string | null {
    const entry = this.#entries.get(name);
    if (!entry) return null;
    if (entry.size > this.maxPartBytes) throw new XlsxError(TOO_LARGE);
    if (this.#u32(entry.offset) !== 0x04034b50) throw new XlsxError(DAMAGED);
    const start = entry.offset + 30 + this.#u16(entry.offset + 26) + this.#u16(entry.offset + 28);
    if (start + entry.packed > this.bytes.length) throw new XlsxError(DAMAGED);
    const packed = this.bytes.subarray(start, start + entry.packed);
    let data: Buffer;
    if (entry.method === 0) data = packed;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        throw new XlsxError(DAMAGED);
      }
    } else throw new XlsxError(DAMAGED);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new XlsxError(DAMAGED);
    return data.toString('utf8');
  }

  #u16(at: number): number {
    if (at < 0 || at + 2 > this.bytes.length) throw new XlsxError(DAMAGED);
    return this.bytes.readUInt16LE(at);
  }

  #u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.length) throw new XlsxError(DAMAGED);
    return this.bytes.readUInt32LE(at);
  }
}

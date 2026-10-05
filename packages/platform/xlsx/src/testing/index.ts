import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A workbook's parts by their paths, as `toXlsx` writes them, for tests: each entry inflated and
 * its CRC checked as a ZIP reader checks it. Throws for what is not such a ZIP.
 */
export function xlsxParts(file: Buffer): Map<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end !== file.length - 22) throw new Error('No ZIP directory at its end');
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const parts = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    if (file.readUInt32LE(at) !== 0x02014b50) throw new Error(`No ZIP entry at ${at}`);
    const size = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28);
    const offset = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (file.readUInt32LE(offset) !== 0x04034b50) throw new Error(`No local header for ${name}`);
    const start = offset + 30 + file.readUInt16LE(offset + 26) + file.readUInt16LE(offset + 28);
    const data = inflateRawSync(file.subarray(start, start + size));
    if (data.length !== file.readUInt32LE(at + 24) || crc32(data) !== file.readUInt32LE(at + 16)) {
      throw new Error(`${name} is not as its ZIP entry says`);
    }
    parts.set(name, data.toString('utf8'));
    at += 46 + nameLength;
  }
  return parts;
}

/**
 * The sheet's rows, the header first, for tests: each cell its text, or its number as kept (a
 * time as days since 30 December 1899), an empty one null.
 */
export function xlsxRows(file: Buffer): (string | number | null)[][] {
  const sheet = xlsxParts(file).get('xl/worksheets/sheet1.xml');
  if (sheet === undefined) throw new Error('No sheet');
  const rows: (string | number | null)[][] = [];
  for (const [, number, cells] of sheet.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
    const row: (string | number | null)[] = [];
    for (const [, column, attributes, content] of cells!.matchAll(
      /<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g,
    )) {
      const index = [...column!].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
      while (row.length < index - 1) row.push(null);
      row.push(
        attributes!.includes('t="inlineStr"')
          ? unescape(/<t[^>]*>([\s\S]*?)<\/t>/.exec(content!)?.[1] ?? '')
          : Number(/<v>([^<]*)<\/v>/.exec(content!)?.[1]),
      );
    }
    rows[Number(number) - 1] = row;
  }
  return Array.from(rows, (row) => row ?? []);
}

function unescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

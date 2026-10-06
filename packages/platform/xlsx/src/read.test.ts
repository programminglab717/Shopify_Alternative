import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { XlsxError, readXlsx, toXlsx } from './index.js';

interface Part {
  path: string;
  text: string;
  /** Kept as it is, not deflated. */
  stored?: boolean;
  /** Its sizes and checksum after its data, as streaming writers put them. */
  descriptor?: boolean;
  flags?: number;
  /** What the directory says it unpacks to, when not what it does. */
  size?: number;
}

/** A ZIP of `parts`, as other writers than Hatti's make them. */
function zipOf(parts: readonly Part[], comment = ''): Buffer {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const data = Buffer.from(part.text, 'utf8');
    const packed = part.stored ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const name = Buffer.from(part.path, 'utf8');
    const flags = (part.descriptor ? 8 : 0) | (part.flags ?? 0);
    const size = part.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(part.stored ? 0 : 8, 8);
    if (!part.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(part.descriptor ? 16 : 0);
    if (part.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    chunks.push(local, name, packed, descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(part.stored ? 0 : 8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + packed.length + descriptor.length;
  }
  const length = directory.reduce((sum, chunk) => sum + chunk.length, 0);
  const note = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...chunks, ...directory, end, note]);
}

const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A workbook of one sheet, `sheet` its sheetData's rows, with shared strings `strings`. */
function workbookOf(sheet: string, strings: readonly string[] = [], extra: Part[] = []): Buffer {
  return zipOf([
    {
      path: '_rels/.rels',
      text: `<Relationships><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: 'xl/workbook.xml',
      text: '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      text:
        `<Relationships><Relationship Id="rId1" Type="${RELS}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${RELS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    {
      path: 'xl/sharedStrings.xml',
      text: `<sst>${strings.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`,
    },
    {
      path: 'xl/worksheets/sheet1.xml',
      text: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    },
    ...extra,
  ]);
}

/** The message a file is refused with. */
function refusal(file: Buffer, options = {}): string {
  try {
    readXlsx(file, options);
  } catch (error) {
    if (error instanceof XlsxError) return error.message;
    throw error;
  }
  throw new Error('Read a file it should have refused');
}

describe('Reading workbooks people send', () => {
  it('reads back the workbooks Hatti writes', () => {
    const file = toXlsx({
      name: 'Orders',
      columns: [
        { header: 'Order' },
        { header: 'Total', type: 'amount' },
        { header: 'Placed', type: 'time' },
      ],
      rows: [
        ['#1001', '2500.50', '2026-09-29 01:30'],
        ['#1002', null, null],
      ],
    });
    expect(readXlsx(file)).toEqual({
      sheet: 'Orders',
      rows: [['Order', 'Total', 'Placed'], ['#1001', 2500.5, 46294.0625], ['#1002']],
      more: false,
    });
  });

  it('reads the first sheet shown as Excel, Google Sheets and LibreOffice keep it', () => {
    const file = zipOf(
      [
        {
          path: '_rels/.rels',
          text: `<Relationships><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
        },
        {
          // The first tab hidden; the one shown names its sheet's part.
          path: 'xl/workbook.xml',
          text:
            '<x:workbook xmlns:x="main" xmlns:r="rel"><x:sheets>' +
            '<x:sheet name="Lookup" sheetId="2" state="hidden" r:id="rId2"/>' +
            '<x:sheet name="Payments &amp; COD" sheetId="1" r:id="rId1"/>' +
            '</x:sheets></x:workbook>',
        },
        {
          path: 'xl/_rels/workbook.xml.rels',
          descriptor: true,
          text:
            `<Relationships><Relationship Id="rId1" Type="${RELS}/worksheet" Target="worksheets/sheet2.xml"/>` +
            `<Relationship Id="rId2" Type="${RELS}/worksheet" Target="/xl/worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId3" Type="${RELS}/sharedStrings" Target="strings.xml"/></Relationships>`,
        },
        {
          // Rich text in runs, an empty string, and readings above Japanese text left out.
          path: 'xl/strings.xml',
          text:
            '<sst count="5"><si><t>Tracking Number</t></si>' +
            '<si><r><t xml:space="preserve">COD </t></r><r><rPr><b/></rPr><t>Amount</t></r></si>' +
            '<si/><si><t xml:space="preserve"> Ayesha &amp; Co_x000D_</t></si>' +
            '<si><t>ناظم آباد</t><rPh sb="0" eb="1"><t>X</t></rPh></si></sst>',
        },
        {
          path: 'xl/worksheets/sheet1.xml',
          text: '<worksheet><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>',
        },
        {
          path: 'xl/worksheets/sheet2.xml',
          stored: true,
          text:
            '<x:worksheet xmlns:x="main"><x:sheetData>' +
            '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c></x:row>' +
            // A number as Excel keeps it, a boolean, and a string of the cell's own.
            '<x:row r="3" spans="1:4"><x:c r="A3"><x:v>123456789012</x:v></x:c><x:c r="B3" s="2"><x:v>6650.5</x:v></x:c>' +
            '<x:c r="C3" t="b"><x:v>1</x:v></x:c><x:c r="D3" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c></x:row>' +
            // A formula's text, an error in the cell after it, and one past a gap.
            '<x:row r="4"><x:c r="A4" t="str"><x:f>A3&amp;"x"</x:f><x:v>LE1x</x:v></x:c><x:c t="e"><x:v>#N/A</x:v></x:c>' +
            '<x:c r="D4" t="s"><x:v>3</x:v></x:c></x:row>' +
            // A row with nothing in it, but its style.
            '<x:row r="5"><x:c r="A5" s="1"/></x:row>' +
            '<x:row r="6"><x:c r="A6" t="s"><x:v>2</x:v></x:c><x:c r="B6" t="s"><x:v>4</x:v></x:c></x:row>' +
            '</x:sheetData></x:worksheet>',
        },
      ],
      'Saved by a spreadsheet',
    );
    expect(readXlsx(file)).toEqual({
      sheet: 'Payments & COD',
      rows: [
        ['Tracking Number', 'COD Amount'],
        [],
        [123456789012, 6650.5, true, 'inline'],
        ['LE1x', '#N/A', null, ' Ayesha & Co\r'],
        [],
        ['', 'ناظم آباد'],
      ],
      more: false,
    });
  });

  it('keeps the rows and columns it is asked to, and says whether more had something in them', () => {
    const rows = [1, 2, 3, 4, 5]
      .map(
        (row) =>
          `<row r="${row}"><c r="A${row}"><v>${row}</v></c><c r="F${row}"><v>0</v></c></row>`,
      )
      .join('');
    expect(readXlsx(workbookOf(rows), { maxRows: 3, maxColumns: 2 })).toEqual({
      sheet: 'Sheet1',
      rows: [[1], [2], [3]],
      more: true,
    });
    // Rows past the last kept with nothing in them are not more.
    const styled = '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" s="1"/></row>';
    expect(readXlsx(workbookOf(styled), { maxRows: 1 }).more).toBe(false);
  });

  it('refuses what is not a workbook it can read, saying why', () => {
    expect(refusal(Buffer.from('CN,COD Amount\nLE1,100'))).toBe('Not an Excel workbook (.xlsx)');
    expect(refusal(zipOf([{ path: 'word/document.xml', text: '<w:document/>' }]))).toBe(
      'Not an Excel workbook (.xlsx)',
    );
    const old = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(old);
    expect(refusal(old)).toMatch(/^An Excel 97-2003 workbook \(\.xls\), or one with a password/);
    const sheet = '<row r="1"><c r="A1"><v>1</v></c></row>';
    expect(
      refusal(workbookOf(sheet, [], [{ path: 'xl/worksheets/sheet1.xml', text: sheet, flags: 1 }])),
    ).toMatch(/or one with a password/);

    // Its bytes changed, or its parts saying they unpack to other than they do.
    const good = workbookOf(sheet);
    const damaged = Buffer.from(good);
    damaged[60] = damaged[60]! ^ 0xff;
    expect(refusal(damaged)).toBe('The workbook is damaged: save it again in Excel, or as CSV');
    const lying = workbookOf(
      sheet,
      [],
      [
        {
          path: 'xl/worksheets/sheet1.xml',
          text: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
          size: 10,
        },
      ],
    );
    expect(refusal(lying)).toBe('The workbook is damaged: save it again in Excel, or as CSV');
    // A part that would unpack to more than the caller takes.
    const big = workbookOf(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(5_000)}</t></is></c></row>`,
    );
    expect(refusal(big, { maxPartBytes: 1_000 })).toBe(
      'The workbook is too large to read: split it',
    );
  });
});

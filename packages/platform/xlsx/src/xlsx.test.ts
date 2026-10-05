import { describe, expect, it } from 'vitest';
import { columnName, toXlsx, type XlsxSheet } from './index.js';
import { xlsxParts as unzip, xlsxRows } from './testing/index.js';

const ORDERS: XlsxSheet = {
  name: 'Orders',
  columns: [
    { header: 'Order' },
    { header: 'Placed', type: 'time' },
    { header: 'Total', type: 'amount' },
    { header: 'Units', type: 'number' },
    { header: 'Note' },
  ],
  rows: [
    ['#1001', '2026-09-29 01:30', '3499.00', 2, 'Deliver after 5 <pm> & call first'],
    ['#1002', null, '125000.50', '1', '=HYPERLINK("https://example.com")'],
  ],
};

describe('Excel workbooks', () => {
  it('writes one sheet in the parts and places Excel looks for them', () => {
    const file = toXlsx(ORDERS);
    expect(file.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
    const parts = unzip(file);
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(parts.get('[Content_Types].xml')).toContain(
      '<Override PartName="/xl/worksheets/sheet1.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    );
    expect(parts.get('xl/workbook.xml')).toContain(
      '<sheet name="Orders" sheetId="1" r:id="rId1"/>',
    );
    // The range its filter covers, as Excel names it.
    expect(parts.get('xl/workbook.xml')).toContain(
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">` +
        `'Orders'!$A$1:$E$3</definedName>`,
    );
    // The same rows make the same file.
    expect(toXlsx(ORDERS).equals(file)).toBe(true);
  });

  it('keeps each cell as its column says, text as text, under a bold header that stays in view', () => {
    const sheet = unzip(toXlsx(ORDERS)).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain(
      '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Order</t></is></c>',
    );
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain('<autoFilter ref="A1:E3"/>');
    // A time is days since 30 December 1899; an amount a number shown with two places.
    expect(sheet).toContain('<c r="B2" s="3"><v>46294.0625</v></c>');
    expect(sheet).toContain('<c r="C2" s="2"><v>3499.00</v></c>');
    expect(sheet).toContain('<c r="D2"><v>2</v></c>');
    expect(sheet).toContain('<c r="C3" s="2"><v>125000.50</v></c>');
    expect(sheet).toContain('<c r="D3"><v>1</v></c>');
    expect(sheet).toContain(
      '<t xml:space="preserve">Deliver after 5 &lt;pm&gt; &amp; call first</t>',
    );
    // What looks like a formula is text, and runs nowhere.
    expect(sheet).toContain(
      '<c r="E3" t="inlineStr"><is><t xml:space="preserve">' +
        '=HYPERLINK(&quot;https://example.com&quot;)</t></is></c>',
    );
    expect(sheet).not.toContain('<f>');
    // An empty cell is left out.
    expect(sheet).not.toContain('r="B3"');
  });

  it('reads back as it wrote, for tests: text, numbers and times', () => {
    expect(xlsxRows(toXlsx(ORDERS))).toEqual([
      ['Order', 'Placed', 'Total', 'Units', 'Note'],
      ['#1001', 46294.0625, 3499, 2, 'Deliver after 5 <pm> & call first'],
      ['#1002', null, 125000.5, 1, '=HYPERLINK("https://example.com")'],
    ]);
    expect(() => unzip(Buffer.from('not a workbook'))).toThrow('No ZIP directory at its end');
  });

  it("keeps as text what a column can't read, and leaves out what XML can't carry", () => {
    const control = String.fromCharCode(0, 0x1b, 0xfffe);
    const urdu = 'آیشہ خان، لاہور';
    const sheet = unzip(
      toXlsx({
        name: 'Checks',
        columns: [
          { header: 'Amount', type: 'amount' },
          { header: 'Time', type: 'time' },
          { header: 'Number', type: 'number' },
          { header: 'Text' },
        ],
        rows: [
          ['n/a', '2026-02-30 10:00', '1e5', `a${control}b\tc\nd`],
          [Number.NaN, '2026-09-29 24:00', -12.5, urdu],
          ['-250.00', '2026-10-05 23:59', 0, 42],
        ],
      }),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">n/a</t>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">2026-02-30 10:00');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">1e5</t>');
    expect(sheet).toContain(`<t xml:space="preserve">ab\tc\nd</t>`);
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">NaN</t>');
    expect(sheet).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve">2026-09-29 24:00');
    expect(sheet).toContain('<c r="C3"><v>-12.5</v></c>');
    expect(sheet).toContain(`<t xml:space="preserve">${urdu}</t>`);
    expect(sheet).toContain('<c r="A4" s="2"><v>-250.00</v></c>');
    expect(sheet).toContain('<c r="B4" s="3"><v>46300.99930555555</v></c>');
    expect(sheet).toContain('<c r="C4"><v>0</v></c>');
    // A number in a column of text is text.
    expect(sheet).toContain('<c r="D4" t="inlineStr"><is><t xml:space="preserve">42</t>');
  });

  it('names columns past Z as Excel does, each as wide as its contents within reason', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    const columns = Array.from({ length: 30 }, (_, index) => ({ header: `Column ${index + 1}` }));
    const sheet = unzip(
      toXlsx({
        name: 'Wide',
        columns,
        rows: [['x', 'y'.repeat(100), ...columns.slice(2).map(() => null)]],
      }),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<autoFilter ref="A1:AD2"/>');
    // "Column 1" and its two places either side; 100 characters kept to 60.
    expect(sheet).toContain('<col min="1" max="1" width="10" customWidth="1"/>');
    expect(sheet).toContain('<col min="2" max="2" width="60" customWidth="1"/>');
    expect(sheet).toContain('<col min="30" max="30" width="11" customWidth="1"/>');
  });

  it("takes a tab's name as Excel does, and refuses a sheet Excel wouldn't open", () => {
    const named = (name: string) =>
      unzip(toXlsx({ name, columns: [{ header: 'A' }], rows: [] })).get('xl/workbook.xml')!;
    expect(named('Orders: [Sept] 2026/27, every single one of them')).toContain(
      '<sheet name="Orders   Sept  2026 27, every s" ',
    );
    expect(named(' ? ')).toContain('<sheet name="Sheet1" ');
    expect(named("Ayesha's & Co")).toContain(
      `<sheet name="Ayesha's &amp; Co" sheetId="1" r:id="rId1"/>`,
    );
    expect(named("Ayesha's & Co")).toContain(`'Ayesha''s &amp; Co'!$A$1:$A$1`);
    expect(() => toXlsx({ name: 'None', columns: [], rows: [] })).toThrow(RangeError);
  });
});

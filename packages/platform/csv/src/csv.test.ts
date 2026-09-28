import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, toCsv } from './index.js';

describe('parseCsv', () => {
  it('reads rows, quoted cells and every kind of line ending', () => {
    expect(parseCsv('Name,Phone\r\nAyesha,0300 1234567\nBilal,"0333, 5551234"\rSana,')).toEqual([
      ['Name', 'Phone'],
      ['Ayesha', '0300 1234567'],
      ['Bilal', '0333, 5551234'],
      ['Sana', ''],
    ]);
  });

  it('reads quotes, line breaks inside quotes, and Urdu', () => {
    expect(parseCsv('"She said ""hi""","Line one\nline two",عائشہ خان\n')).toEqual([
      ['She said "hi"', 'Line one\nline two', 'عائشہ خان'],
    ]);
  });

  it('drops a byte-order mark and blank lines, and keeps empty cells', () => {
    expect(parseCsv('\uFEFFa,b\n\n,\n\r\n"",x\n')).toEqual([
      ['a', 'b'],
      ['', ''],
      ['', 'x'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('says where a quote is left open', () => {
    expect(() => parseCsv('a,b\nc,"never\nclosed')).toThrow(
      new CsvError('A quoted cell is never closed', 2),
    );
  });
});

describe('toCsv', () => {
  it('quotes only what needs quoting, with CRLF line endings and a byte-order mark', () => {
    expect(
      toCsv([
        ['Name', 'Tags', 'Orders'],
        ['Ayesha "Ashi" Khan', 'vip, eid', 3],
        [null, ' padded ', 0],
      ]),
    ).toBe('\uFEFFName,Tags,Orders\r\n"Ayesha ""Ashi"" Khan","vip, eid",3\r\n," padded ",0\r\n');
    expect(toCsv([['a']], { bom: false })).toBe('a\r\n');
  });

  it('keeps spreadsheets from running cells as formulas', () => {
    expect(toCsv([['=HYPERLINK("x")', '+92300', '-5', '@SUM', 'safe']], { bom: false })).toBe(
      `"'=HYPERLINK(""x"")",'+92300,'-5,'@SUM,safe\r\n`,
    );
    // Numbers are data, not text a person typed.
    expect(toCsv([[-5]], { bom: false })).toBe('-5\r\n');
  });

  it('round-trips through parseCsv', () => {
    const rows = [
      ['Name', 'Note'],
      ['Zainab, Hyderabad', 'Line 1\r\nLine 2 "quoted"'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

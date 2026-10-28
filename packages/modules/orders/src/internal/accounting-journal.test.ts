import { parseCsv } from '@hatti/csv';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEDGERS, journalFile, journalOf, ledgersOf } from './accounting-journal.js';
import { tallyOf, type SalesPeriod } from './sales-report.service.js';

const KARACHI = 'Asia/Karachi';

/** A day in Karachi, starting at its midnight, with what its orders came to in rupees' paisa. */
const day = (date: string, tally: Partial<SalesPeriod>): SalesPeriod => ({
  ...tallyOf([]),
  start: new Date(`${date}T00:00:00+05:00`),
  ...tally,
});

/** 5 October: two suits sold at Rs 6,000 with Rs 500 off, one refused; delivery and COD fees. */
const OCTOBER_5 = day('2026-10-05', {
  orders: 2,
  grossSales: 1_200_000n,
  discounts: 50_000n,
  returns: 600_000n,
  shipping: 30_000n,
  additionalFees: 10_000n,
  taxes: 0n,
  costOfGoods: 350_000n,
  refunds: 0n,
  shippingCosts: 50_000n,
  shippingCostsEstimated: 20_000n,
  writeOffs: 35_000n,
  claimsRecovered: 15_000n,
});

const writing = { ledgers: DEFAULT_LEDGERS, currency: 'PKR' };
const span = { first: '2026-10-05', last: '2026-10-06' };

describe("A shop's sales as a journal for its books (ADR-885)", () => {
  it('posts each day with orders as an entry whose debits and credits are equal', () => {
    const [entry, ...rest] = journalOf([OCTOBER_5, day('2026-10-06', {})], KARACHI, false);
    // A day with nothing to post has no entry.
    expect(rest).toEqual([]);
    expect(entry!.day).toBe('2026-10-05');
    expect(entry!.number).toBe('HATTI-20261005');
    const posted = entry!.lines.map((line) => [line.account, line.debit, line.credit]);
    expect(posted).toEqual([
      ['receivable', 590_000n, 0n],
      ['discounts', 50_000n, 0n],
      ['returns', 600_000n, 0n],
      ['sales', 0n, 1_200_000n],
      ['shipping', 0n, 30_000n],
      ['fees', 0n, 10_000n],
      ['cost_of_goods', 350_000n, 0n],
      ['inventory', 0n, 350_000n],
    ]);
  });

  it("adds refunds paid, and true profit's lines where the plan has them, charged ones only", () => {
    const [entry] = journalOf([{ ...OCTOBER_5, refunds: 120_000n, taxes: 90_000n }], KARACHI, true);
    const of = (account: string) =>
      entry!.lines
        .filter((line) => line.account === account)
        .map((line) => [line.debit, line.credit]);
    expect(of('sales_tax')).toEqual([[0n, 90_000n]]);
    expect(of('receivable')).toEqual([
      [680_000n, 0n],
      [120_000n, 0n],
    ]);
    expect(of('bank')).toEqual([[0n, 120_000n]]);
    // Rs 300 of couriers' charges were on statements; Rs 200 only estimated is not posted.
    expect(of('courier_charges')).toEqual([[30_000n, 0n]]);
    expect(of('couriers')).toEqual([
      [0n, 30_000n],
      [15_000n, 0n],
    ]);
    expect(of('write_offs')).toEqual([[35_000n, 0n]]);
    expect(of('inventory')).toEqual([
      [0n, 350_000n],
      [0n, 35_000n],
    ]);
    expect(of('claims')).toEqual([[0n, 15_000n]]);
    const sum = (side: 'debit' | 'credit') =>
      entry!.lines.reduce((total, line) => total + line[side], 0n);
    expect(sum('debit')).toBe(sum('credit'));
  });

  it('posts an amount below nothing on the other side', () => {
    const [entry] = journalOf(
      [day('2026-10-05', { grossSales: 10_000n, taxes: -500n })],
      KARACHI,
      false,
    );
    expect(entry!.lines.find((line) => line.account === 'sales_tax')).toMatchObject({
      debit: 500n,
      credit: 0n,
    });
  });

  it('writes a CSV of its lines, by the names and codes the shop gave', () => {
    const entries = journalOf([OCTOBER_5], KARACHI, false);
    const ledgers = ledgersOf([{ account: 'sales', code: '41000', name: 'Online sales' }]);
    const file = journalFile(entries, 'csv', { ...writing, ledgers }, span);
    expect(file.filename).toBe('journal-2026-10-05-to-2026-10-06.csv');
    const rows = parseCsv(file.content.toString('utf8'));
    expect(rows[0]).toEqual([
      'Date',
      'Entry',
      'Account code',
      'Account',
      'Description',
      'Debit',
      'Credit',
    ]);
    expect(rows[1]).toEqual([
      '2026-10-05',
      'HATTI-20261005',
      '1200',
      'Sales receivable',
      "What the day's orders came to",
      '5900',
      '',
    ]);
    expect(rows[4]).toEqual([
      '2026-10-05',
      'HATTI-20261005',
      '41000',
      'Online sales',
      'Items at the prices sold, without their tax',
      '',
      '12000',
    ]);
  });

  it("writes Xero's and QuickBooks' imports, a credit negative in Xero's", () => {
    const entries = journalOf([OCTOBER_5], KARACHI, false);
    const xero = parseCsv(journalFile(entries, 'xero', writing, span).content.toString('utf8'));
    expect(xero[0]).toEqual([
      '*Narration',
      '*Date',
      'Description',
      '*AccountCode',
      '*TaxRate',
      '*Amount',
    ]);
    expect(xero[1]).toEqual([
      'Sales of 2026-10-05, from Hatti',
      '05/10/2026',
      "What the day's orders came to",
      '1200',
      'Tax Exempt',
      '5900',
    ]);
    expect(xero[4]![5]).toBe('-12000');
    const books = parseCsv(
      journalFile(entries, 'quickbooks', writing, span).content.toString('utf8'),
    );
    expect(books[0]).toEqual([
      'JournalNo',
      'JournalDate',
      'AccountName',
      'Debits',
      'Credits',
      'Description',
    ]);
    expect(books[4]).toEqual([
      'HATTI-20261005',
      '05/10/2026',
      'Sales',
      '',
      '12000',
      'Items at the prices sold, without their tax',
    ]);
  });

  it("writes Tally's journal vouchers, a debit negative and deemed positive", () => {
    const entries = journalOf([OCTOBER_5], KARACHI, false);
    const ledgers = ledgersOf([{ account: 'sales', code: '4000', name: 'Sales & <Online>' }]);
    const file = journalFile(entries, 'tally', { ...writing, ledgers }, span);
    expect(file.filename).toBe('journal-2026-10-05-to-2026-10-06-tally.xml');
    const xml = file.content.toString('utf8');
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<VOUCHER VCHTYPE="Journal" ACTION="Create">');
    expect(xml).toContain('<DATE>20261005</DATE>');
    expect(xml).toMatch(
      /<LEDGERNAME>Sales receivable<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>-5900.00<\/AMOUNT>/,
    );
    expect(xml).toMatch(
      /<LEDGERNAME>Sales &amp; &lt;Online&gt;<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>12000.00<\/AMOUNT>/,
    );
  });
});

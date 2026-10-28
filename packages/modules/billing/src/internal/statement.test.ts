import { describe, expect, it } from 'vitest';
import { StatementError, matchStatement, statementCredits } from './statement.js';

// A statement as a Pakistani bank exports it: its own lines first, then the heading, debits and
// credits apart, amounts with thousands' commas.
const STATEMENT = [
  'Standard Chartered Bank (Pakistan) Limited',
  'Account Statement,PK36SCBL0000001123456702',
  '',
  'Txn Date,Value Date,Narration,Ref No,Debit,Credit,Balance',
  '01-11-2026,01-11-2026,IBFT FROM SANA AHMED REF FT24100012,,,"2,999.00","102,999.00"',
  '01-11-2026,01-11-2026,RAAST P2P FT-2410-0099 GUL LAWN,RAAST123,,"2,000.00","104,999.00"',
  '02-11-2026,02-11-2026,SERVER RENT,,"5,000.00",,"99,999.00"',
  '02-11-2026,02-11-2026,IBFT FROM ALI,FT24100555,,500,"100,499.00"',
  '03-11-2026,03-11-2026,IBFT FROM ALI AGAIN,FT24100555,,500,"100,999.00"',
  '03-11-2026,03-11-2026,CASH DEPOSIT,,,"10,000.00","110,999.00"',
].join('\n');

describe("Matching Hatti's bank statement (ADR-883)", () => {
  it("reads its credits under the bank's own heading, debits passed over", () => {
    const credits = statementCredits(STATEMENT);
    expect(credits.map((credit) => [credit.row, credit.date, credit.amount])).toEqual([
      [4, '01-11-2026', 299900n],
      [5, '01-11-2026', 200000n],
      [7, '02-11-2026', 50000n],
      [8, '03-11-2026', 50000n],
      [9, '03-11-2026', 1000000n],
    ]);
    expect(credits[1]!.description).toBe('RAAST P2P FT-2410-0099 GUL LAWN · RAAST123');
  });

  it("pairs each credit with the transfer whose reference it carries, however it's written", () => {
    const result = matchStatement(STATEMENT, [
      { id: 't1', reference: 'FT24100012', amount: 299900n },
      { id: 't2', reference: 'ft 2410 0099', amount: 299900n },
      { id: 't3', reference: 'FT24100555', amount: 50000n },
      { id: 't4', reference: 'NOT-THERE', amount: 100000n },
      { id: 't5', reference: 'FT', amount: 100000n },
    ]);
    expect(result.credits).toBe(5);
    expect(
      result.matches.map((match) => [match.transferId, match.credit.row, match.outcome]),
    ).toEqual([
      ['t1', 4, 'exact'],
      ['t2', 5, 'short'],
    ]);
    // Two credits carry t3's reference: Hatti's people look. Too short a reference matches none.
    expect(result.ambiguous).toEqual(['t3']);
    expect(result.unmatched.map((credit) => credit.row)).toEqual([7, 8, 9]);
  });

  it('says why it reads no statement', () => {
    expect(() => statementCredits('Date,Amount\n01-11-2026,500')).toThrow(StatementError);
    expect(() => statementCredits('"unclosed')).toThrow(/isn't CSV Hatti can read/);
  });
});

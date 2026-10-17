import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSettlement } from './settlement-statement.js';
import { PaymentSettlementService, matchSettlement } from './settlements.service.js';
import { errorsOf, paymentsFixture, unwrap, type PaymentsFixture } from './test-support.js';

const server = testDatabaseServer();

const STATEMENT = [
  'Safepay settlement report',
  'Merchant: Zari,Period: 1-15 Oct 2026',
  '',
  'Transaction ID,Gross Amount (Rs),MDR,WHT,Net Amount',
  'track_A1,"2,000.00",(50.00),20.00,"1,930.00"',
  'TRACK_B2,1500,37.50,15,1447.50',
  'track_zz,900,22.5,9,868.5',
  'track_A1,2000,50,20,1930',
  'refund_A1,(500),0,0,(500)',
  'track_c3,abc,0,0,0',
  'Total,7400,160,64,7176',
].join('\n');

describe("Gateways' settlement statements (PAY-07, ADR-491)", () => {
  it('reads a statement under its title rows, deductions however signed, and passes its totals over', () => {
    const read = unwrap(readSettlement(STATEMENT, 'PKR'));
    expect(read.rows).toBe(7);
    expect(
      read.lines.map((line) => [
        line.row,
        line.reference,
        line.gross,
        line.fees,
        line.tax,
        line.net,
      ]),
    ).toEqual([
      [4, 'track_A1', 200000n, 5000n, 2000n, 193000n],
      [5, 'TRACK_B2', 150000n, 3750n, 1500n, 144750n],
      [6, 'track_zz', 90000n, 2250n, 900n, 86850n],
      [7, 'track_A1', 200000n, 5000n, 2000n, 193000n],
      [8, 'refund_A1', -50000n, 0n, 0n, -50000n],
    ]);
    expect(read.rowErrors).toEqual([
      { row: 9, column: 'Gross Amount (Rs)', message: '"abc" is not an amount' },
    ]);
    expect(errorsOf(readSettlement('Date,Amount\n2026-10-01,100', 'PKR'))).toEqual([
      ['csv', 'INVALID'],
    ]);
  });

  it('matches lines to payments by either reference, and says what is off', () => {
    const lines = unwrap(readSettlement(STATEMENT, 'PKR')).lines;
    const sessions = [
      { id: 's1', order_id: 'o1', paid_amount: 200000, gateway_ref: 'TRACK_a1', reference: null },
      { id: 's2', order_id: 'o2', paid_amount: 160000, gateway_ref: null, reference: 'track_b2' },
    ];
    expect(matchSettlement(lines, sessions, new Set()).map((line) => line.outcome)).toEqual([
      'matched',
      'differs',
      'unmatched',
      'repeated',
      'refund',
    ]);
    expect(matchSettlement(lines.slice(0, 1), sessions, new Set(['s1']))[0]!.outcome).toBe(
      'repeated',
    );
  });
});

describe.skipIf(!server)("Gateways' settlements in the database (PAY-07, ADR-491)", () => {
  let f: PaymentsFixture;
  let settlements: PaymentSettlementService;
  let account: string;

  async function paidSession(gatewayRef: string, amount: number): Promise<string> {
    const id = newId();
    await f.admin.query(
      `INSERT INTO payments.sessions (shop_id, id, account_id, order_id, environment, amount,
                                      currency, status, gateway_ref, paid_amount, paid_through,
                                      paid_at, reference)
       VALUES ($1, $2, $3, $4, 'production', $5, 'PKR', 'paid', $6, $5, 'webhook', now(), $7)`,
      [f.a.shopId, id, account, newId(), amount, gatewayRef, `ref-${gatewayRef}`],
    );
    return id;
  }

  beforeAll(async () => {
    f = await paymentsFixture(server!);
    settlements = new PaymentSettlementService(f.db);
    account = newId();
    await f.admin.query(
      `INSERT INTO payments.gateway_accounts (shop_id, id, gateway, environment, credentials,
                                              credentials_hint)
       VALUES ($1, $2, 'safepay', 'production', 'sealed', 'abcd')`,
      [f.a.shopId, account],
    );
  }, 120_000);
  afterAll(() => f?.close());

  it('imports a statement whole, keeps fees and tax beside each payment, and refuses it twice', async () => {
    await paidSession('track_A1', 200000);
    await paidSession('track_B2', 160000);
    const csv = STATEMENT;
    const dry = unwrap(await settlements.import(f.a, { accountId: account, csv, dryRun: true }));
    expect(dry).toMatchObject({
      settlement: null,
      rows: 7,
      outcomes: { matched: 1, differs: 1, unmatched: 1, repeated: 1, refund: 1 },
      gross: 590000n,
      fees: 16000n,
      tax: 6400n,
      net: 567600n,
      rowErrorCount: 1,
      dryRun: true,
    });
    expect(dry.issues.map((line) => [line.row, line.outcome])).toEqual([
      [5, 'differs'],
      [6, 'unmatched'],
      [7, 'repeated'],
    ]);
    expect(await settlements.list(f.a)).toEqual([]);

    const made = unwrap(
      await settlements.import(f.a, { accountId: account, csv, reference: 'SP-2026-10-15' }),
    );
    expect(made.settlement).toMatchObject({
      gateway: 'safepay',
      reference: 'SP-2026-10-15',
      lineCount: 5,
      fees: 16000n,
      tax: 6400n,
      net: 567600n,
    });
    const id = made.settlement!.id;
    expect(
      (await settlements.lines(f.a, id, 'differs')).map((line) => [line.transactionRef, line.paid]),
    ).toEqual([['TRACK_B2', 160000n]]);
    expect((await settlements.list(f.a)).map((each) => each.id)).toEqual([id]);
    expect(await settlements.list(f.b)).toEqual([]);

    // The same reference again is refused; the same payments in another are settled already.
    expect(
      errorsOf(
        await settlements.import(f.a, { accountId: account, csv, reference: 'SP-2026-10-15' }),
      ),
    ).toEqual([['reference', 'TAKEN']]);
    const again = unwrap(await settlements.import(f.a, { accountId: account, csv, dryRun: true }));
    expect(again.outcomes).toMatchObject({ matched: 0, differs: 0, repeated: 3 });
    // Another shop's account is no account of the shop's.
    expect(errorsOf(await settlements.import(f.b, { accountId: account, csv }))).toEqual([
      ['accountId', 'NOT_FOUND'],
    ]);
  });
});

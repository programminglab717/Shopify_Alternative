import type { CourierParcel, OrderCod } from '@hatti/orders/public';
import { toXlsx } from '@hatti/xlsx';
import { describe, expect, it } from 'vitest';
import { parcelFor, reconcile } from './reconcile.js';
import {
  amountOf,
  digestOf,
  headingKey,
  readStatement,
  readStatementWorkbook,
  type StatementLine,
} from './statement.js';

function read(csv: string) {
  const result = readStatement(csv, 'PKR');
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("Couriers' statements", () => {
  it('reads the columns couriers name their own ways, and amounts as they write them', () => {
    expect(
      ['Tracking Number', 'CN #', 'C.N. No.', 'COD Amount (Rs)', 'Net Payable PKR'].map(headingKey),
    ).toEqual(['tracking number', 'cn', 'c n no', 'cod amount', 'net payable']);
    expect(
      ['1,250', 'Rs. 1,250.50', 'PKR 300', '(150)', '-150', '', '-', 'abc', '1.234'].map((text) =>
        amountOf(text, 'PKR'),
      ),
    ).toEqual([125_000n, 125_050n, 30_000n, -15_000n, -15_000n, null, null, undefined, undefined]);

    const statement = read(
      [
        'Sr #,CN #,Consignee,COD Amount,Delivery Charges,WHT,Net Payable',
        '1, le 4402917 ,Ayesha Khan,"6,650",250,(66.50),"6,333.50"',
        '2,LE4402918,Sana Tariq,0,180,,',
        '3,,Nobody,500,,,',
        '4,LE4402919,Bilal,lots,,,',
        ',,Total,"7,150",430,66.50,"6,333.50"',
      ].join('\n'),
    );
    expect(statement.rows).toBe(5);
    expect(statement.lines).toEqual([
      {
        row: 2,
        trackingNumber: 'le 4402917',
        key: 'LE4402917',
        collected: 665_000n,
        charges: 25_000n,
        tax: 6_650n,
        net: 633_350n,
      },
      {
        row: 3,
        trackingNumber: 'LE4402918',
        key: 'LE4402918',
        collected: 0n,
        charges: 18_000n,
        tax: 0n,
        net: null,
      },
    ]);
    // The totals row is passed over; the rest that cannot be read are said, and counted.
    expect([statement.rowErrorCount, statement.rowErrors]).toEqual([
      2,
      [
        { row: 4, column: 'CN #', message: 'The tracking number is missing' },
        { row: 5, column: 'COD Amount', message: '"lots" is not an amount' },
      ],
    ]);
  });

  it('refuses a file it cannot take as a statement', () => {
    const codes = (csv: string) => {
      const result = readStatement(csv, 'PKR');
      return result.ok ? null : result.errors.map((error) => error.code);
    };
    expect(codes('   ')).toEqual(['BLANK']);
    expect(codes('CN,COD Amount')).toEqual(['BLANK']);
    expect(codes('Consignee,COD Amount\nAyesha,100')).toEqual(['INVALID']);
    expect(codes('CN,Consignee\nLE1,Ayesha')).toEqual(['INVALID']);
    expect(codes('CN,COD Amount\n"LE1,100')).toEqual(['INVALID']);
    expect(codes(`CN,COD Amount\n${'LE1,100\n'.repeat(5_001)}`)).toEqual(['TOO_MANY']);
  });

  it("finds the header under a courier's title rows, passes over empty rows, and says when Excel shortened a number (ADR-246)", () => {
    const statement = read(
      [
        'TCS Payment Statement',
        'Account,ZARI-001',
        ',,',
        'CN,COD Amount',
        '1.23457E+11,"2,000"',
        ',,',
        '779412345678,"1,500"',
      ].join('\n'),
    );
    expect(statement.rows).toBe(2);
    expect(statement.lines.map((line) => [line.row, line.trackingNumber, line.collected])).toEqual([
      [7, '779412345678', 150_000n],
    ]);
    expect(statement.rowErrors).toEqual([
      {
        row: 5,
        column: 'CN',
        message:
          '"1.23457E+11" is a tracking number Excel shortened: import the courier\'s Excel file ' +
          'itself, not a CSV saved from it',
      },
    ]);
  });

  it('reads a statement from the Excel workbook a courier sends, its long numbers whole (ADR-246)', () => {
    const workbook = toXlsx({
      name: 'Statement',
      columns: [
        { header: 'CN', type: 'number' },
        { header: 'COD Amount', type: 'amount' },
        { header: 'Delivery Charges', type: 'amount' },
      ],
      rows: [
        ['779412345678', '6650.50', '250'],
        ['779412345679', '0', '180'],
        ['', 'lots', null],
      ],
    });
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const result = readStatementWorkbook(
      `data:${type};base64,${workbook.toString('base64')}`,
      'PKR',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(
      result.value.lines.map((line) => [
        line.row,
        line.trackingNumber,
        line.collected,
        line.charges,
      ]),
    ).toEqual([
      [2, '779412345678', 665_050n, 25_000n],
      [3, '779412345679', 0n, 18_000n],
    ]);
    expect(result.value.rowErrors).toEqual([
      { row: 4, column: 'CN', message: 'The tracking number is missing' },
    ]);
    // The same lines as a CSV of them: the same statement.
    expect(digestOf(result.value.lines)).toEqual(
      digestOf(
        read('CN,COD Amount,Delivery Charges\n779412345678,"6,650.50",250\n779412345679,0,180')
          .lines,
      ),
    );

    const refused = (base64: string) => {
      const read = readStatementWorkbook(base64, 'PKR');
      return read.ok ? null : read.errors.map((error) => [error.field.join('.'), error.code]);
    };
    expect(refused('')).toEqual([['xlsx', 'BLANK']]);
    expect(refused('not base64!')).toEqual([['xlsx', 'INVALID']]);
    expect(refused(Buffer.from('CN,COD Amount\nLE1,100').toString('base64'))).toEqual([
      ['xlsx', 'INVALID'],
    ]);
    const old = Buffer.alloc(64);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(old);
    const message = readStatementWorkbook(old.toString('base64'), 'PKR');
    expect(message.ok ? null : message.errors[0]!.message).toMatch(
      /^An Excel 97-2003 workbook \(\.xls\), or one with a password, cannot be read/,
    );
  });

  it('knows a statement by its lines, however it was saved', () => {
    const digest = (csv: string) => digestOf(read(csv).lines).toString('hex');
    const first = digest('CN,COD Amount,Charges\nLE1,"2,000",150\nLE2,0,180\n,Total,"2,000",330');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Sorted, spaced, its columns named and ordered otherwise, and its amounts written otherwise.
    expect(digest('Charges,Tracking No,COD\nRs 180,le 2,\n150.00,LE1,2000')).toBe(first);
    // Another amount, another line, or a net paid over is another statement.
    expect(digest('CN,COD Amount,Charges\nLE1,"2,000",150\nLE2,0,190')).not.toBe(first);
    expect(digest('CN,COD Amount,Charges\nLE1,"2,000",150\nLE2,0,180\nLE2,0,180')).not.toBe(first);
    expect(digest('CN,COD Amount,Charges,Net\nLE1,"2,000",150,"1,850"\nLE2,0,180,(180)')).not.toBe(
      first,
    );
  });

  it("takes each line's cash on the order its parcel is for, at most what the order owes", () => {
    const parcel = (
      id: string,
      orderId: string,
      company: string | null = 'Leopards',
      status: CourierParcel['status'] = 'delivered',
    ) => ({ id, orderId, trackingNumber: id, trackingCompany: company, status }) as CourierParcel;
    const order = (id: string, owed: bigint, payable = true): [string, OrderCod] => [
      id,
      { id, number: 1000 + Number(id.slice(1)), payable, owed },
    ];
    const line = (row: number, collected: bigint, charges = 0n): StatementLine => ({
      row,
      trackingNumber: `P${row}`,
      key: `P${row}`,
      collected,
      charges,
      tax: 0n,
      net: null,
    });
    const orders = new Map([
      order('o1', 5_000n),
      order('o2', 5_000n),
      order('o3', 5_000n),
      order('o4', 0n),
      order('o5', 3_000n, false),
      order('o6', 6_000n),
      order('o7', 2_000n),
      order('o8', 3_000n),
    ]);
    const parcels = [
      parcel('p1', 'o1'),
      parcel('p2', 'o2'),
      parcel('p3', 'o3'),
      null,
      parcel('p1', 'o1'),
      parcel('p4', 'o4'),
      parcel('p4b', 'o4'),
      parcel('p5', 'o5'),
      parcel('p6', 'o6'),
      parcel('p7', 'o6'),
      parcel('p8', 'o1'),
      parcel('p9', 'o7', 'Leopards', 'returning'),
      parcel('p10', 'o8'),
    ];
    const lines = reconcile(
      [
        line(2, 5_000n),
        line(3, 4_000n),
        line(4, 7_000n),
        line(5, 100n),
        line(6, 5_000n),
        line(7, 900n),
        line(8, 0n, 200n),
        line(9, 3_000n),
        line(10, 4_000n),
        line(11, 4_000n),
        line(12, 1_000n),
        line(13, 0n, 150n),
        line(14, 0n),
      ],
      parcels,
      orders,
      new Map([['p8', [1_000n]]]),
    );
    expect(lines.map((each) => [each.row, each.outcome, each.owed, each.received])).toEqual([
      [2, 'received', 5_000n, 5_000n],
      [3, 'short', 5_000n, 4_000n],
      [4, 'over', 5_000n, 5_000n],
      [5, 'unmatched', null, 0n],
      // The same parcel again in the statement.
      [6, 'repeated', 0n, 0n],
      [7, 'not_owed', 0n, 0n],
      // A parcel sent back: the courier's charges alone.
      [8, 'charged', 0n, 0n],
      [9, 'not_owed', 0n, 0n],
      // An order's parcels take from what it owes in turn.
      [10, 'short', 6_000n, 4_000n],
      [11, 'over', 2_000n, 2_000n],
      // Its cash collected in an earlier statement.
      [12, 'repeated', 0n, 0n],
      // No cash on a parcel coming back: charges alone, though its order owes on paper; on a
      // parcel delivered, none of what is owed.
      [13, 'charged', 2_000n, 0n],
      [14, 'short', 3_000n, 0n],
    ]);
    expect(lines[0]).toMatchObject({ fulfillmentId: 'p1', orderId: 'o1', orderNumber: 1001 });

    // Of parcels with the same number, the courier's, else the newest.
    const tcs = parcel('t1', 'o1', ' TCS ');
    const leopards = parcel('l1', 'o2');
    expect(parcelFor([leopards, tcs], 'tcs')).toBe(tcs);
    expect(parcelFor([leopards, tcs], 'M&P')).toBe(leopards);
    expect(parcelFor([], 'TCS')).toBeNull();
  });

  it('receives cash a courier paid short on an earlier statement, but not the same cash again (ADR-246)', () => {
    const parcel = (id: string, orderId: string) =>
      ({
        id,
        orderId,
        trackingNumber: id,
        trackingCompany: 'TCS',
        status: 'delivered',
      }) as CourierParcel;
    const line = (row: number, collected: bigint): StatementLine => ({
      row,
      trackingNumber: `P${row}`,
      key: `P${row}`,
      collected,
      charges: 0n,
      tax: 0n,
      net: null,
    });
    // Each was paid 2,000 of 2,500 before, but o3, paid in full.
    const orders = new Map<string, OrderCod>([
      ['o1', { id: 'o1', number: 1001, payable: true, owed: 500n }],
      ['o2', { id: 'o2', number: 1002, payable: true, owed: 500n }],
      ['o3', { id: 'o3', number: 1003, payable: true, owed: 0n }],
      ['o4', { id: 'o4', number: 1004, payable: true, owed: 500n }],
    ]);
    const lines = reconcile(
      [line(2, 500n), line(3, 2_000n), line(4, 500n), line(5, 300n)],
      [parcel('p1', 'o1'), parcel('p2', 'o2'), parcel('p3', 'o3'), parcel('p4', 'o4')],
      orders,
      new Map([
        ['p1', [2_000n]],
        ['p2', [2_000n]],
        ['p3', [2_500n]],
        ['p4', [2_000n]],
      ]),
    );
    expect(lines.map((each) => [each.row, each.outcome, each.owed, each.received])).toEqual([
      // The shortfall, paid.
      [2, 'received', 500n, 500n],
      // The same cash again: the parcel listed again, not paid twice.
      [3, 'repeated', 500n, 0n],
      // Its order owing nothing since.
      [4, 'repeated', 0n, 0n],
      // Less than the shortfall: what came is received, and the rest is owed still.
      [5, 'short', 500n, 300n],
    ]);
  });

  it("pays a lost parcel's claim with its cash, unless the shop settled the claim otherwise", () => {
    const lost = (
      id: string,
      orderId: string,
      claimStatus: CourierParcel['claimStatus'],
      status: CourierParcel['status'] = 'lost',
    ): CourierParcel => ({
      id,
      orderId,
      trackingNumber: id,
      trackingCompany: 'TCS',
      status,
      claimStatus,
    });
    const line = (row: number, collected: bigint, charges = 0n): StatementLine => ({
      row,
      trackingNumber: `P${row}`,
      key: `P${row}`,
      collected,
      charges,
      tax: 0n,
      net: null,
    });
    // A lost order owes nothing; one with a parcel delivered beside the lost one still does.
    const orders = new Map<string, OrderCod>([
      ['o1', { id: 'o1', number: 1001, payable: false, owed: 0n }],
      ['o2', { id: 'o2', number: 1002, payable: true, owed: 5_000n }],
    ]);
    const lines = reconcile(
      [
        line(2, 2_000n),
        line(3, 1_500n),
        line(4, 1_000n),
        line(5, 1_000n),
        line(6, 1_000n),
        line(7, 0n, 150n),
        line(8, 2_000n),
        line(9, 2_000n),
        line(10, 5_000n),
      ],
      [
        lost('p1', 'o1', null),
        lost('p2', 'o1', 'open'),
        lost('p3', 'o1', 'refused'),
        lost('p4', 'o1', 'paid'),
        lost('p5', 'o1', 'withdrawn'),
        lost('p6', 'o1', 'open'),
        lost('p1', 'o1', null),
        lost('p7', 'o2', null),
        lost('p8', 'o2', null, 'delivered'),
      ],
      orders,
      new Map(),
    );
    expect(lines.map((each) => [each.row, each.outcome, each.owed, each.received])).toEqual([
      // Not claimed yet, claimed, or refused: the claim is paid.
      [2, 'compensated', 0n, 0n],
      [3, 'compensated', 0n, 0n],
      [4, 'compensated', 0n, 0n],
      // Paid by hand, or withdrawn: to look into.
      [5, 'not_owed', 0n, 0n],
      [6, 'not_owed', 0n, 0n],
      // Charges alone, as for any parcel.
      [7, 'charged', 0n, 0n],
      // Its cash once.
      [8, 'repeated', 0n, 0n],
      // Its order owes for another parcel: the claim is paid, and what the order owes is left
      // to that parcel's cash.
      [9, 'compensated', 5_000n, 0n],
      [10, 'received', 5_000n, 5_000n],
    ]);
  });
});

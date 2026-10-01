import type { CourierParcel, OrderCod } from '@hatti/orders/public';
import { describe, expect, it } from 'vitest';
import { parcelFor, reconcile } from './reconcile.js';
import { amountOf, headingKey, readStatement, type StatementLine } from './statement.js';

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
      new Set(['p8']),
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
});

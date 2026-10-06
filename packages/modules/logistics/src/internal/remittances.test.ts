import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { toXlsx } from '@hatti/xlsx';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codRemittanceLines, codRemittances } from './schema.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('CodRemittanceService', () => {
  let f: LogisticsFixture;
  let kurta: string;
  let shawl: string;

  const STATEMENT = [
    'CN,Consignee,COD Amount,Charges,Tax',
    'LE1001,Ayesha Khan,"2,000",150,20',
    'LE1002,Sana Tariq,"4,500",150,45',
    'le 1003,Bilal Ahmed,"2,000",150,20',
    'LE9999,Nobody,500,,',
    'LE1004,Hina Malik,"2,000",150,20',
    'LE1005,Usman Ali,0,180,',
  ].join('\n');

  beforeAll(async () => {
    f = await logisticsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
    shawl = await f.variantOf(f.a, 'Pashmina Shawl', '5,000');
  });

  /**
   * Parcels for {@link STATEMENT}: delivered; delivered; still on its way, its number typed in
   * capitals; paid already by hand; and sent back.
   */
  async function parcels() {
    const leopards = (number: string) => ({ company: 'Leopards', number });
    const paidInFull = await f.delivered(f.a, kurta, leopards('LE1001'));
    const paidShort = await f.delivered(f.a, shawl, leopards('LE1002'));
    const onItsWay = await f.shipped(f.a, kurta, leopards('LE 1003'));
    const paidBefore = await f.delivered(f.a, kurta, leopards('LE1004'));
    unwrap(await f.orders.markAsPaid(f.a, paidBefore.orderId));
    const sentBack = await f.shipped(f.a, kurta, leopards('LE1005'));
    unwrap(await f.fulfillments.markReturning(f.a, sentBack.fulfillmentId));
    return { paidInFull, paidShort, onItsWay, paidBefore, sentBack };
  }

  it('matches the migrated tables', async () => {
    await f.db.tenant(f.a.shopId, async (tx) => {
      for (const table of [codRemittances, codRemittanceLines]) {
        await tx.select().from(table).limit(1);
      }
    });
  });

  it("receives each parcel's cash on its order, and keeps what to look into", async () => {
    const { paidInFull, paidShort, onItsWay, paidBefore, sentBack } = await parcels();
    const imported = unwrap(
      await f.remittances.import(f.a, {
        courier: 'Leopards',
        csv: STATEMENT,
        reference: 'LHR-0042',
      }),
    );
    expect(imported).toMatchObject({
      rows: 6,
      outcomes: {
        received: 2,
        short: 1,
        over: 0,
        unmatched: 1,
        repeated: 0,
        not_owed: 1,
        charged: 1,
      },
      collected: 11_000_00n,
      charges: 780_00n,
      tax: 105_00n,
      paid: 10_115_00n,
      received: 8_500_00n,
      rowErrorCount: 0,
      dryRun: false,
    });
    expect(imported.issues.map((line) => [line.row, line.outcome, line.orderNumber])).toEqual([
      [3, 'short', paidShort.number],
      [5, 'unmatched', null],
      [6, 'not_owed', paidBefore.number],
    ]);
    expect(imported.remittance).toMatchObject({
      courier: 'Leopards',
      reference: 'LHR-0042',
      lineCount: 6,
      received: 8_500_00n,
      issueCount: 3,
    });

    // Paid in full, in part, and paid on its way; the rest as they were.
    const order = async (id: string) => (await f.orders.get(f.a, id))!;
    expect(await order(paidInFull.orderId)).toMatchObject({
      financialStatus: 'paid',
      amountPaid: 2_000_00n,
      stage: 'completed',
    });
    expect(await order(paidShort.orderId)).toMatchObject({
      financialStatus: 'partially_paid',
      amountPaid: 4_500_00n,
      stage: 'delivered',
    });
    expect(await order(onItsWay.orderId)).toMatchObject({
      financialStatus: 'paid',
      stage: 'in_transit',
    });
    expect(await order(paidBefore.orderId)).toMatchObject({ amountPaid: 2_000_00n });
    expect(await order(sentBack.orderId)).toMatchObject({ amountPaid: 0n });
    const timeline = await f.orders.timeline(f.a, paidShort.orderId, { first: 50 });
    expect(timeline.items.map((entry) => entry.message)).toContain(
      'Rs 4,500 received from Leopards, statement LHR-0042',
    );
    const events = (await f.outbox()).map((event) => [event.event_type, event.aggregate_id]);
    expect(events).toEqual(
      expect.arrayContaining([
        ['order.paid', paidInFull.orderId],
        ['order.updated', paidShort.orderId],
        ['order.paid', onItsWay.orderId],
        ['cod_remittance.imported', imported.remittance!.id],
      ]),
    );

    // Its lines, all or those to look into, a page at a time.
    const id = imported.remittance!.id;
    const issues = await f.remittances.lines(f.a, id, { first: 50, issuesOnly: true });
    expect(issues.map((line) => line.row)).toEqual([3, 5, 6]);
    const page = await f.remittances.lines(f.a, id, { first: 2, after: 3 });
    expect(page.map((line) => [line.row, line.trackingNumber])).toEqual([
      [4, 'le 1003'],
      [5, 'LE9999'],
    ]);
    expect(await f.remittances.get(f.a, id)).toMatchObject({ issueCount: 3, paid: 10_115_00n });
    expect((await f.remittances.list(f.a, { first: 10 })).items.map((each) => each.id)).toEqual([
      id,
    ]);

    // The same statement again: refused by its reference, or by its lines however it was saved,
    // with another reference or none.
    expect(
      errorsOf(
        await f.remittances.import(f.a, {
          courier: 'leopards',
          csv: STATEMENT,
          reference: 'LHR-0042',
        }),
      ),
    ).toEqual([['reference', 'TAKEN']]);
    const resaved = [
      'Tax,Consignment No,Delivery Charges,COD Value',
      '0,LE1005,180,0',
      '20,LE 1004,Rs. 150,"2,000.00"',
      ',LE9999,,500',
      '20,LE1001,150,2000',
      '45,LE1002,150,4500',
      '20,LE1003,150,2000',
      'Total,,780,"11,000"',
    ].join('\n');
    for (const reference of [null, 'LHR-0043']) {
      const again = await f.remittances.import(f.a, {
        courier: 'Leopards',
        csv: resaved,
        reference,
      });
      expect(again.ok ? [] : again.errors).toEqual([
        {
          field: ['csv'],
          code: 'TAKEN',
          message:
            'This statement has the same lines as the statement LHR-0042 from Leopards, ' +
            'imported already',
        },
      ]);
    }
    expect(await order(paidShort.orderId)).toMatchObject({ amountPaid: 4_500_00n });

    // Each shop its own.
    expect((await f.remittances.list(f.b, { first: 10 })).items).toEqual([]);
    expect(await f.remittances.get(f.b, id)).toBeNull();
    const elsewhere = unwrap(
      await f.remittances.import(f.b, { courier: 'Leopards', csv: STATEMENT, dryRun: true }),
    );
    expect(elsewhere.outcomes.unmatched).toBe(6);
  });

  it('says what a statement would do, writing nothing, and reads its rows as it can', async () => {
    const { paidInFull } = await parcels();
    const csv = `${STATEMENT}\nLE1006,Nadia,lots,,\n,,Total,"11,000",780`;
    const dry = unwrap(await f.remittances.import(f.a, { courier: 'Leopards', csv, dryRun: true }));
    expect(dry).toMatchObject({
      remittance: null,
      rows: 8,
      outcomes: { received: 2, short: 1 },
      received: 8_500_00n,
      rowErrorCount: 1,
      rowErrors: [{ row: 8, column: 'COD Amount', message: '"lots" is not an amount' }],
      dryRun: true,
    });
    expect((await f.remittances.list(f.a, { first: 10 })).items).toEqual([]);
    expect((await f.orders.get(f.a, paidInFull.orderId))!.amountPaid).toBe(0n);
    expect(errorsOf(await f.remittances.import(f.a, { courier: ' ', csv }))).toEqual([
      ['courier', 'BLANK'],
    ]);
  });

  it("takes a statement once, and a parcel's cash once, when imported at the same time", async () => {
    const parcel = await f.delivered(f.a, shawl, { company: 'TCS', number: 'TCS77' });
    const csv = 'Tracking Number,COD Amount,Charges\nTCS77,"5,000",150';
    const twice = await Promise.all(
      [0, 1].map(() => f.remittances.import(f.a, { courier: 'TCS', csv })),
    );
    expect(twice.map((result) => (result.ok ? 'imported' : errorsOf(result)))).toEqual(
      expect.arrayContaining(['imported', [['csv', 'TAKEN']]]),
    );
    // Two statements naming the parcel: its cash is received once, and the charges with it.
    const both = await Promise.all(
      ['Tracking Number,COD Amount,Charges\nTCS77,"5,000",160', 'CN,COD\nTCS77,5000'].map((other) =>
        f.remittances.import(f.a, { courier: 'TCS', csv: other }),
      ),
    );
    expect(both.map((result) => unwrap(result).received)).toEqual([0n, 0n]);
    const order = (await f.orders.get(f.a, parcel.orderId))!;
    expect(order).toMatchObject({ amountPaid: 5_000_00n, financialStatus: 'paid' });
    expect(order.fulfillments[0]!.courierCharges).toBe(150_00n);
  });

  it('receives a shortfall the courier pays on a later statement, as CSV or Excel, but not the same cash again (ADR-246)', async () => {
    const parcel = await f.delivered(f.a, shawl, { company: 'TCS', number: '779412345678' });
    const workbook = (rows: string[][]) =>
      toXlsx({
        name: 'Statement',
        columns: [
          { header: 'CN', type: 'number' },
          { header: 'COD Amount', type: 'amount' },
        ],
        rows,
      }).toString('base64');
    // Paid short: 4,500 of 5,000.
    const short = unwrap(
      await f.remittances.import(f.a, {
        courier: 'TCS',
        csv: 'CN,COD Amount\n779412345678,"4,500"',
        reference: 'S-1',
      }),
    );
    expect([short.outcomes.short, short.received]).toEqual([1, 4_500_00n]);
    // Listed again with the same cash, beside another parcel: nothing received.
    const again = unwrap(
      await f.remittances.import(f.a, {
        courier: 'TCS',
        xlsx: workbook([
          ['779412345678', '4500'],
          ['779400000000', '100'],
        ]),
        reference: 'S-2',
      }),
    );
    expect([again.outcomes.repeated, again.outcomes.unmatched, again.received]).toEqual([1, 1, 0n]);
    // The shortfall, on the courier's next statement, its tracking number a number in Excel.
    const paid = unwrap(
      await f.remittances.import(f.a, {
        courier: 'TCS',
        xlsx: workbook([['779412345678', '500']]),
        reference: 'S-3',
      }),
    );
    expect([paid.outcomes.received, paid.received]).toEqual([1, 500_00n]);
    expect(await f.orders.get(f.a, parcel.orderId)).toMatchObject({
      amountPaid: 5_000_00n,
      financialStatus: 'paid',
    });

    // Given both ways, or neither, it says so.
    expect(
      errorsOf(
        await f.remittances.import(f.a, { courier: 'TCS', csv: 'CN,COD\nX,1', xlsx: workbook([]) }),
      ),
    ).toEqual([['xlsx', 'INVALID']]);
    expect(errorsOf(await f.remittances.import(f.a, { courier: 'TCS' }))).toEqual([
      ['csv', 'BLANK'],
    ]);
  });

  it('keeps what couriers charged for each parcel, both ways, and once', async () => {
    const tcs = (number: string) => ({ company: 'TCS', number });
    const delivered = await f.delivered(f.a, kurta, tcs('TCS1'));
    const sentBack = await f.shipped(f.a, kurta, tcs('TCS2'));
    unwrap(await f.fulfillments.markReturning(f.a, sentBack.fulfillmentId));
    const charges = async (id: string) =>
      (await f.orders.get(f.a, id))!.fulfillments[0]!.courierCharges;
    expect(await charges(sentBack.orderId)).toBeNull();

    // Out: the parcel delivered, with its cash, and the one sent back, without.
    const out = 'CN,COD Amount,Charges\nTCS1,"2,000",150\nTCS2,0,150';
    unwrap(await f.remittances.import(f.a, { courier: 'TCS', csv: out, dryRun: true }));
    expect(await charges(sentBack.orderId)).toBeNull();
    unwrap(await f.remittances.import(f.a, { courier: 'TCS', csv: out, reference: 'S-1' }));
    expect(await charges(delivered.orderId)).toBe(150_00n);
    expect(await charges(sentBack.orderId)).toBe(150_00n);

    // Back: the return in two lines; the delivered parcel's cash again, and its charges, taken
    // before.
    await f.admin.query('DELETE FROM platform.outbox_events');
    const back = 'CN,COD Amount,Charges\nTCS2,0,120\nTCS1,"2,000",150\nTCS2,0,30';
    const imported = unwrap(
      await f.remittances.import(f.a, { courier: 'TCS', csv: back, reference: 'S-2' }),
    );
    expect(imported.outcomes).toMatchObject({ charged: 1, repeated: 2 });
    expect(await charges(delivered.orderId)).toBe(150_00n);
    expect(await charges(sentBack.orderId)).toBe(300_00n);
    const timeline = await f.orders.timeline(f.a, sentBack.orderId, { first: 50 });
    expect(
      timeline.items.filter((entry) => entry.kind === 'charged').map((entry) => entry.message),
    ).toEqual([
      'TCS charged Rs 150 for the parcel TCS2, statement S-2',
      'TCS charged Rs 150 for the parcel TCS2, statement S-1',
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'fulfillment.updated')
        .map((event) => [event.aggregate_id, event.payload.changed]),
    ).toEqual([[sentBack.fulfillmentId, ['courierCharges']]]);

    // Charges alone, alike on two statements: told apart by their references, and only so.
    const alike = 'CN,COD Amount,Charges\nTCS2,0,50';
    unwrap(await f.remittances.import(f.a, { courier: 'TCS', csv: alike, reference: 'S-3' }));
    const unnamed = await f.remittances.import(f.a, { courier: 'TCS', csv: alike });
    expect(unnamed.ok ? null : unnamed.errors[0]!.message).toBe(
      'This statement has the same lines as the statement S-3 from TCS, imported already; if ' +
        'it is another statement, give its reference',
    );
    unwrap(await f.remittances.import(f.a, { courier: 'TCS', csv: alike, reference: 'S-4' }));
    expect(await charges(sentBack.orderId)).toBe(400_00n);
    expect(
      errorsOf(await f.remittances.import(f.a, { courier: 'tcs', csv: alike, reference: 'S-4' })),
    ).toEqual([['reference', 'TAKEN']]);
    expect(
      errorsOf(await f.remittances.import(f.a, { courier: 'TCS', csv: alike, reference: 'S-3 ' })),
    ).toEqual([['reference', 'TAKEN']]);

    // Each shop its own.
    const elsewhere = unwrap(await f.remittances.import(f.b, { courier: 'TCS', csv: alike }));
    expect(elsewhere.outcomes.unmatched).toBe(1);
  });

  it('pays the claims of lost parcels, filing those the shop had not', async () => {
    const lost = async (number: string) => {
      const parcel = await f.shipped(f.a, kurta, { company: 'TCS', number });
      unwrap(await f.fulfillments.markLost(f.a, parcel.fulfillmentId));
      return parcel;
    };
    const [unclaimed, open, refused, paidByHand, withdrawn, charged] = [
      await lost('L1'),
      await lost('L2'),
      await lost('L3'),
      await lost('L4'),
      await lost('L5'),
      await lost('L6'),
    ];
    for (const parcel of [open, refused, paidByHand, withdrawn, charged]) {
      unwrap(await f.fulfillments.claim(f.a, parcel.fulfillmentId));
    }
    unwrap(await f.fulfillments.settleClaim(f.a, refused.fulfillmentId, { status: 'refused' }));
    unwrap(
      await f.fulfillments.settleClaim(f.a, paidByHand.fulfillmentId, {
        status: 'paid',
        amount: '1,000',
      }),
    );
    unwrap(await f.fulfillments.settleClaim(f.a, withdrawn.fulfillmentId, { status: 'withdrawn' }));
    const claimOf = async (parcel: { orderId: string }) =>
      (await f.orders.get(f.a, parcel.orderId))!.fulfillments[0]!.claim;

    const csv = [
      'CN,COD Amount,Charges',
      'L1,"2,500",100',
      'L2,"1,500",',
      'L3,"2,000",',
      'L4,"1,000",',
      'L5,"2,000",',
      'L6,0,150',
    ].join('\n');
    const dry = unwrap(await f.remittances.import(f.a, { courier: 'TCS', csv, dryRun: true }));
    expect(dry).toMatchObject({ compensated: 6_000_00n, received: 0n });
    expect(dry.outcomes).toMatchObject({ compensated: 3, not_owed: 2, charged: 1 });
    expect(await claimOf(unclaimed)).toBeNull();

    await f.admin.query('DELETE FROM platform.outbox_events');
    const imported = unwrap(
      await f.remittances.import(f.a, { courier: 'TCS', csv, reference: 'S-9' }),
    );
    expect(imported.outcomes).toMatchObject({ compensated: 3, not_owed: 2, charged: 1 });
    expect(imported.remittance).toMatchObject({
      compensated: 6_000_00n,
      received: 0n,
      issueCount: 2,
    });
    expect(imported.issues.map((line) => [line.trackingNumber, line.outcome])).toEqual([
      ['L4', 'not_owed'],
      ['L5', 'not_owed'],
    ]);
    // Not claimed: claimed at what was paid, as more than its worth, and paid.
    expect(await claimOf(unclaimed)).toEqual({
      status: 'paid',
      amount: 2_500_00n,
      paid: 2_500_00n,
      note: null,
      claimedAt: expect.any(Date),
      settledAt: expect.any(Date),
    });
    expect(await claimOf(open)).toMatchObject({
      status: 'paid',
      amount: 2_000_00n,
      paid: 1_500_00n,
    });
    expect(await claimOf(refused)).toMatchObject({ status: 'paid', paid: 2_000_00n });
    expect(await claimOf(paidByHand)).toMatchObject({ status: 'paid', paid: 1_000_00n });
    expect(await claimOf(withdrawn)).toMatchObject({ status: 'withdrawn', paid: null });
    expect(await claimOf(charged)).toMatchObject({ status: 'open' });
    expect((await f.orders.get(f.a, charged.orderId))!.fulfillments[0]!.courierCharges).toBe(
      150_00n,
    );
    // Nothing received on the lost orders.
    expect((await f.orders.get(f.a, open.orderId))!).toMatchObject({
      amountPaid: 0n,
      financialStatus: 'voided',
    });
    const timeline = await f.orders.timeline(f.a, open.orderId, { first: 1 });
    expect(timeline.items[0]!.message).toBe(
      'TCS paid Rs 1,500 on the claim for the lost parcel L2, statement S-9',
    );
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'fulfillment.updated')
        .map((event) => [event.aggregate_id, event.payload.changed]),
    ).toEqual(
      expect.arrayContaining([
        [unclaimed.fulfillmentId, ['claim']],
        [open.fulfillmentId, ['claim']],
        [refused.fulfillmentId, ['claim']],
      ]),
    );

    // A parcel's cash once: paid again in another statement, it is to look into.
    const again = unwrap(
      await f.remittances.import(f.a, {
        courier: 'TCS',
        csv: 'CN,COD Amount\nL1,"2,500"',
        reference: 'S-10',
      }),
    );
    expect(again.outcomes).toMatchObject({ repeated: 1, compensated: 0 });
    expect(await claimOf(unclaimed)).toMatchObject({ paid: 2_500_00n });
  });
});

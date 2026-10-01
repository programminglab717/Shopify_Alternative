import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
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

    // The same statement again: refused by its reference, or, without one, received nothing.
    expect(
      errorsOf(
        await f.remittances.import(f.a, {
          courier: 'leopards',
          csv: STATEMENT,
          reference: 'LHR-0042',
        }),
      ),
    ).toEqual([['reference', 'TAKEN']]);
    const again = unwrap(await f.remittances.import(f.a, { courier: 'Leopards', csv: STATEMENT }));
    expect(again).toMatchObject({
      outcomes: { received: 0, repeated: 4, unmatched: 1, charged: 1 },
      received: 0n,
    });
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

  it('receives a parcel once when two statements name it at the same time', async () => {
    const parcel = await f.delivered(f.a, shawl, { company: 'TCS', number: 'TCS77' });
    const csv = 'Tracking Number,COD Amount\nTCS77,"5,000"';
    const both = await Promise.all(
      ['A-1', 'A-2'].map((reference) =>
        f.remittances.import(f.a, { courier: 'TCS', csv, reference }),
      ),
    );
    const received = both.map((result) => unwrap(result).received);
    expect(received.sort()).toEqual([0n, 5_000_00n]);
    expect((await f.orders.get(f.a, parcel.orderId))!).toMatchObject({
      amountPaid: 5_000_00n,
      financialStatus: 'paid',
    });
  });
});

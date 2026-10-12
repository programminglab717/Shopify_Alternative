import 'reflect-metadata';
import type { MutationResult } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Couriers, type CourierAdapter } from './couriers.js';
import { CourierPickupService } from './pickups.service.js';
import { logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

/** The user errors a result gave, with what each said. */
function said(result: MutationResult<unknown>): [string, string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code, error.message]);
}

describe.skipIf(!server)('Courier pickups (ADR-253)', () => {
  let f: LogisticsFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await logisticsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    f.testCourier.pickups.length = 0;
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  async function connect(courier: 'test' | 'leopards', name: string) {
    const credentials =
      courier === 'test'
        ? [{ key: 'key', value: 'anything-1234' }]
        : [
            { key: 'apiKey', value: 'leopards-key-1234' },
            { key: 'apiPassword', value: 'leopards-password' },
          ];
    return unwrap(
      await f.accounts.connect(f.a, { courier, name, credentials, pickupCode: 'LHR-0042' }),
    );
  }

  it("hands an account's parcels waiting to be picked up to its courier, and keeps its sheet", async () => {
    await connect('test', 'Test Lahore');
    const first = await f.booked(f.a, kurta);
    const second = await f.booked(f.a, kurta);
    // Picked up already, as its courier says: not handed over again.
    const gone = await f.booked(f.a, kurta);
    await f.admin.query(
      `UPDATE logistics.bookings SET parcel_status = 'in_transit' WHERE shop_id = $1 AND id = $2`,
      [f.a.shopId, gone.bookingId],
    );

    const pickup = unwrap(await f.pickups.request(f.a, {}));
    expect(pickup).toMatchObject({
      courier: 'test',
      courierName: 'Test courier',
      status: 'requested',
      parcelCount: 2,
      reference: 'HTL000001',
      rider: null,
      error: null,
      requestedBy: { kind: 'app' },
    });
    expect(pickup.requestedAt).toBeInstanceOf(Date);
    // The longest waiting first, from the account's pickup address.
    expect(f.testCourier.pickups).toEqual([
      {
        trackingNumbers: [first.trackingNumber, second.trackingNumber],
        pickupCode: 'LHR-0042',
        rider: null,
      },
    ]);
    // The courier's own sheet, kept for the shop to print again.
    expect(pickup.documentKey).toBe(`shops/${f.a.shopId}/pickups/${pickup.id}.pdf`);
    const kept = await f.storage.read(pickup.documentKey!);
    expect(kept?.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(f.pickups.documentUrlOf(pickup)).toMatch(
      /^https:\/\/hatti\.test\/storage\/.*test-load-sheet-HTL000001\.pdf/,
    );
    expect(
      (await f.pickups.bookingsOf(f.a, pickup.id)).map((booking) => booking.trackingNumber),
    ).toEqual([first.trackingNumber, second.trackingNumber]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'courier_pickup.requested')
        .map((event) => [event.aggregate_id, event.payload]),
    ).toEqual([
      [
        pickup.id,
        {
          accountId: pickup.accountId,
          courier: 'test',
          parcelCount: 2,
          reference: 'HTL000001',
          byHand: false,
        },
      ],
    ]);

    // Nothing more waits: none is handed over twice.
    expect(said(await f.pickups.request(f.a, {}))).toEqual([
      ['accountId', 'INVALID', "None of this account's parcels waits to be picked up"],
    ]);
    // A parcel booked since goes in the next; one its rider missed, a day on, goes again.
    const third = await f.booked(f.a, kurta);
    await f.admin.query(
      `UPDATE logistics.pickups SET requested_at = now() - interval '25 hours'
        WHERE shop_id = $1 AND id = $2`,
      [f.a.shopId, pickup.id],
    );
    await f.admin.query(
      `UPDATE logistics.bookings SET parcel_status = 'in_transit' WHERE shop_id = $1 AND id = $2`,
      [f.a.shopId, second.bookingId],
    );
    const next = unwrap(await f.pickups.request(f.a, {}));
    expect(f.testCourier.pickups[1]!.trackingNumbers).toEqual([
      first.trackingNumber,
      third.trackingNumber,
    ]);
    expect(next).toMatchObject({ parcelCount: 2, reference: 'HTL000002' });
    // The first keeps the parcels it handed over, which its load sheet lists for the rider to
    // sign, whatever their couriers say of them since.
    expect((await f.pickups.bookingsOf(f.a, pickup.id)).length).toBe(2);
    const sheet = unwrap(
      await f.documents.loadSheet(f.a, { pickupId: pickup.id, language: 'english' }),
    );
    expect(sheet.bookings.map((booking) => booking.trackingNumber)).toEqual([
      first.trackingNumber,
      second.trackingNumber,
    ]);
    expect(
      said(await f.documents.loadSheet(f.b, { pickupId: pickup.id, language: 'english' })),
    ).toEqual([['pickupId', 'NOT_FOUND', 'Pickup not found']]);
    expect((await f.pickups.list(f.a, { first: 10 })).map((each) => each.id)).toEqual([
      next.id,
      pickup.id,
    ]);
    // Another shop sees none of them.
    expect(await f.pickups.list(f.b, { first: 10 })).toEqual([]);
    expect(await f.pickups.get(f.b, pickup.id)).toBeNull();
  });

  it('leaves the parcels for the next pickup when the courier refuses, saying why', async () => {
    await connect('test', 'Test Lahore');
    const parcel = await f.booked(f.a, kurta);
    f.testCourier.nextPickup = { ok: false, retry: true, message: 'Test courier: down for now' };
    expect(said(await f.pickups.request(f.a, {}))).toEqual([
      ['accountId', 'UNAVAILABLE', 'Test courier: down for now'],
    ]);
    f.testCourier.nextPickup = { ok: false, retry: false, message: 'Test courier: no such parcel' };
    expect(said(await f.pickups.request(f.a, {}))[0]?.[1]).toBe('INVALID');
    const [refused] = await f.pickups.list(f.a, { first: 1 });
    expect(refused).toMatchObject({
      status: 'failed',
      error: 'Test courier: no such parcel',
      requestedAt: null,
      documentKey: null,
    });
    expect(f.pickups.documentUrlOf(refused!)).toBeNull();
    const taken = unwrap(await f.pickups.request(f.a, {}));
    expect(taken.status).toBe('requested');
    expect(f.testCourier.pickups.at(-1)!.trackingNumbers).toEqual([parcel.trackingNumber]);

    // One never answered, as when the process stopped while asking, lets its parcels go.
    const again = await f.booked(f.a, kurta);
    const stuck = newId();
    const account = taken.accountId;
    await f.admin.query(
      `INSERT INTO logistics.pickups (shop_id, id, account_id, parcel_count, requested_by_kind,
                                      requested_by_id, created_at)
       VALUES ($1, $2, $3, 1, 'app', 'test', now() - interval '11 minutes')`,
      [f.a.shopId, stuck, account],
    );
    await f.admin.query(
      `INSERT INTO logistics.pickup_parcels (shop_id, pickup_id, booking_id) VALUES ($1, $2, $3)`,
      [f.a.shopId, stuck, again.bookingId],
    );
    unwrap(await f.pickups.request(f.a, {}));
    expect(f.testCourier.pickups.at(-1)!.trackingNumbers).toEqual([again.trackingNumber]);
    expect(await f.pickups.get(f.a, stuck)).toMatchObject({
      status: 'failed',
      error: 'The courier never answered',
    });
  });

  it("checks off a pickup's parcels as its rider takes them, scanned from their labels (ADR-377)", async () => {
    await connect('test', 'Test Lahore');
    const first = await f.booked(f.a, kurta);
    const second = await f.booked(f.a, kurta);
    const pickup = unwrap(await f.pickups.request(f.a, {}));
    expect(pickup.handedOverCount).toBe(0);
    const handed = async () =>
      (await f.pickups.parcelsOf(f.a, pickup.id)).map((parcel) => [
        parcel.booking.trackingNumber,
        parcel.handedOverAt !== null,
      ]);
    expect(await handed()).toEqual([
      [first.trackingNumber, false],
      [second.trackingNumber, false],
    ]);

    // Read off the label, spaces and case as a scanner or a thumb gives them.
    const scanned = ` ${first.trackingNumber!.toLowerCase().replace(/(.{3})/, '$1 ')} `;
    const done = unwrap(await f.pickups.handOver(f.a, pickup.id, scanned));
    expect(done.already).toBe(false);
    expect(done.parcel.booking.id).toBe(first.bookingId);
    expect(done.parcel.handedOverAt).toBeInstanceOf(Date);
    expect(done.parcel.handedOverBy).toEqual({
      kind: 'app',
      id: (f.a.actor as { tokenId: string }).tokenId,
    });
    // Scanned twice: said, and as it was.
    const twice = unwrap(await f.pickups.handOver(f.a, pickup.id, first.trackingNumber!));
    expect(twice.already).toBe(true);
    expect(twice.parcel.handedOverAt).toEqual(done.parcel.handedOverAt);
    expect(await handed()).toEqual([
      [first.trackingNumber, true],
      [second.trackingNumber, false],
    ]);
    expect((await f.pickups.get(f.a, pickup.id))!.handedOverCount).toBe(1);

    // A parcel not in the pickup, a blank scan, another shop's pickup, and one refused.
    const later = await f.booked(f.a, kurta);
    expect(said(await f.pickups.handOver(f.a, pickup.id, later.trackingNumber!))).toEqual([
      ['trackingNumber', 'NOT_FOUND', 'No parcel of this pickup has that tracking number'],
    ]);
    expect(said(await f.pickups.handOver(f.a, pickup.id, '   '))[0]?.[1]).toBe('INVALID');
    expect(said(await f.pickups.handOver(f.b, pickup.id, second.trackingNumber!))).toEqual([
      ['pickupId', 'NOT_FOUND', 'Pickup not found'],
    ]);
    f.testCourier.nextPickup = { ok: false, retry: false, message: 'Test courier: no rider today' };
    await f.pickups.request(f.a, {});
    const [refused] = await f.pickups.list(f.a, { first: 1 });
    expect(refused!.status).toBe('failed');
    expect(said(await f.pickups.handOver(f.a, refused!.id, later.trackingNumber!))).toEqual([
      ['pickupId', 'INVALID', 'Only a pickup its courier has taken has parcels to hand over'],
    ]);

    unwrap(await f.pickups.handOver(f.a, pickup.id, second.trackingNumber!));
    expect((await f.pickups.get(f.a, pickup.id))!.handedOverCount).toBe(2);
  });

  it('records parcels handed to a rider by hand, the courier not asked, and checks them off (ADR-378)', async () => {
    expect(said(await f.pickups.recordByHand(f.a, {}))).toEqual([
      ['accountId', 'BLANK', 'Connect a courier account first'],
    ]);
    await connect('test', 'Test Lahore');
    expect(said(await f.pickups.recordByHand(f.a, {}))).toEqual([
      ['accountId', 'INVALID', "None of this account's parcels waits to be picked up"],
    ]);
    const first = await f.booked(f.a, kurta);
    const second = await f.booked(f.a, kurta);

    const handed = unwrap(
      await f.pickups.recordByHand(f.a, { riderName: 'Imran', riderCode: ' R-77 ' }),
    );
    expect(handed).toMatchObject({
      status: 'requested',
      byHand: true,
      parcelCount: 2,
      handedOverCount: 0,
      reference: null,
      rider: { name: 'Imran', code: 'R-77' },
      documentKey: null,
      error: null,
    });
    expect(handed.requestedAt).toBeInstanceOf(Date);
    // The courier was not asked.
    expect(f.testCourier.pickups).toEqual([]);
    expect(
      (await f.pickups.parcelsOf(f.a, handed.id)).map((parcel) => parcel.booking.trackingNumber),
    ).toEqual([first.trackingNumber, second.trackingNumber]);
    const event = (await f.outbox()).find((each) => each.event_type === 'courier_pickup.requested');
    expect(event?.payload).toMatchObject({ parcelCount: 2, reference: null, byHand: true });

    // Its parcels are in it, as a pickup's are: none waits for another, and each is checked off.
    expect(said(await f.pickups.request(f.a, {}))[0]?.[2]).toBe(
      "None of this account's parcels waits to be picked up",
    );
    unwrap(await f.pickups.handOver(f.a, handed.id, first.trackingNumber!));
    expect((await f.pickups.get(f.a, handed.id))!.handedOverCount).toBe(1);
    // A rider asked through the API is not by hand.
    await f.booked(f.a, kurta);
    expect(unwrap(await f.pickups.request(f.a, {})).byHand).toBe(false);
  });

  it("lists parcels handed to a rider that the courier's tracking has not seen a day on (ADR-379)", async () => {
    await connect('test', 'Test Lahore');
    const [seen, unseen, recent, unhanded] = [
      await f.booked(f.a, kurta),
      await f.booked(f.a, kurta),
      await f.booked(f.a, kurta),
      await f.booked(f.a, kurta),
    ];
    const pickup = unwrap(await f.pickups.recordByHand(f.a, { riderName: 'Imran' }));
    for (const parcel of [seen, unseen, recent]) {
      unwrap(await f.pickups.handOver(f.a, pickup.id, parcel.trackingNumber!));
    }
    // Two handed over a day and more ago, one an hour ago; one never handed over.
    const handedAt = async (bookingId: string, hours: number) =>
      f.admin.query(
        `UPDATE logistics.pickup_parcels SET handed_over_at = now() - make_interval(hours => $2)
          WHERE booking_id = $1`,
        [bookingId, hours],
      );
    await handedAt(seen.bookingId, 30);
    await handedAt(unseen.bookingId, 26);
    await handedAt(recent.bookingId, 1);
    // The courier's tracking has the first on its way.
    await f.admin.query(
      `UPDATE logistics.bookings SET parcel_status = 'in_transit' WHERE id = $1`,
      [seen.bookingId],
    );

    const listed = await f.pickups.unseen(f.a, 20);
    expect(listed.map((each) => each.booking.id)).toEqual([unseen.bookingId]);
    expect(listed[0]).toMatchObject({
      pickupId: pickup.id,
      rider: { name: 'Imran', code: null },
    });
    expect(listed[0]!.handedOverAt.getTime()).toBeLessThan(Date.now() - 25 * 3_600_000);
    expect(unhanded.bookingId).not.toBe(unseen.bookingId);
    // Another shop sees none of it.
    expect(await f.pickups.unseen(f.b, 20)).toEqual([]);

    // Handed over again in a later pickup an hour ago: not unseen until a day after that.
    await f.admin.query(
      `UPDATE logistics.pickups SET requested_at = now() - interval '2 days' WHERE id = $1`,
      [pickup.id],
    );
    const again = unwrap(await f.pickups.recordByHand(f.a, {}));
    unwrap(await f.pickups.handOver(f.a, again.id, unseen.trackingNumber!));
    await f.admin.query(
      `UPDATE logistics.pickup_parcels SET handed_over_at = now() - interval '1 hour'
        WHERE pickup_id = $1 AND booking_id = $2`,
      [again.id, unseen.bookingId],
    );
    expect(await f.pickups.unseen(f.a, 20)).toEqual([]);
  });

  it('asks for the rider where the courier does, and refuses a courier whose API takes none', async () => {
    expect(said(await f.pickups.request(f.a, {}))).toEqual([
      ['accountId', 'BLANK', 'Connect a courier account first'],
    ]);
    expect(said(await f.pickups.request(f.a, { accountId: newId() }))).toEqual([
      ['accountId', 'NOT_FOUND', 'Courier account not found'],
    ]);
    const leopards = await connect('leopards', 'Leopards Lahore');
    expect(said(await f.pickups.request(f.a, { accountId: leopards.id }))).toEqual([
      ['riderName', 'BLANK', "Leopards asks for its rider's name"],
      ['riderCode', 'BLANK', "Leopards asks for its rider's code"],
    ]);
    expect(
      said(
        await f.pickups.request(f.a, {
          accountId: leopards.id,
          riderName: 'x'.repeat(101),
          riderCode: 'R-1',
        }),
      )[0]?.slice(0, 2),
    ).toEqual(['riderName', 'TOO_LONG']);

    // A courier whose API takes no pickups: its load sheet is printed for its rider.
    const plain: CourierAdapter = {
      info: {
        courier: 'plain',
        name: 'Plain',
        credentials: [{ key: 'key', label: 'Key' }],
        pickupCode: null,
        pickups: null,
        test: true,
      },
      book: async () => ({ ok: false, retry: false, message: 'never' }),
      track: async () => ({ ok: true, value: [] }),
      cancel: async () => ({ ok: true, value: null }),
    };
    const pickups = new CourierPickupService(f.db, new Couriers([plain]), f.accounts, f.storage);
    const { rows } = await f.admin.query<{ id: string }>(
      `INSERT INTO logistics.courier_accounts (shop_id, courier, name, credentials,
                                               credentials_hint)
       VALUES ($1, 'plain', 'Plain', 'sealed', '1234') RETURNING id`,
      [f.a.shopId],
    );
    expect(said(await pickups.request(f.a, { accountId: rows[0]!.id }))).toEqual([
      [
        'accountId',
        'INVALID',
        "Plain takes no pickups through its API: print the account's load sheet for its rider",
      ],
    ]);
  });
});

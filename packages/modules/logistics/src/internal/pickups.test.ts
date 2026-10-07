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
        { accountId: pickup.accountId, courier: 'test', parcelCount: 2, reference: 'HTL000001' },
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

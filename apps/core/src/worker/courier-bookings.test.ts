import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import {
  CourierAccountService,
  CourierBookingService,
  Couriers,
  TRACK_EVERY_MS,
  type CourierAdapter,
  type CourierInfo,
  type CourierResult,
  type CourierShipment,
  type CourierTracking,
  type ShipmentStatusChangedPayload,
} from '@hatti/logistics/public';
import { FulfillmentService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_GIVE_UP_MS, CourierBookings } from './courier-bookings.js';
import { ParcelSteps, STEP_OF } from './parcel-steps.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

type Booked = CourierResult<{ trackingNumber: string }>;

/** A courier that answers as each test says. */
class ScriptedCourier implements CourierAdapter {
  readonly info: CourierInfo = {
    courier: 'scripted',
    name: 'Scripted',
    credentials: [{ key: 'key', label: 'Key' }],
    pickupCode: 'Pickup code',
    test: true,
  };

  /** What it was asked to book, and to cancel. */
  booked: CourierShipment[] = [];
  cancelled: string[] = [];
  /** How it answers the next bookings, in turn; booked, numbered, when none is left. */
  answers: (Booked | (() => Promise<Booked>))[] = [];
  /** What it says of parcels; nothing of those it has no status for. */
  statuses = new Map<string, string>();
  /** How tracking fails, while it does. */
  down: CourierResult<CourierTracking[]> | null = null;
  #numbered = 0;

  async book(_credentials: unknown, shipment: CourierShipment): Promise<Booked> {
    this.booked.push(shipment);
    const next = this.answers.shift();
    if (typeof next === 'function') return next();
    return next ?? { ok: true, value: { trackingNumber: `SC-${++this.#numbered}` } };
  }

  async track(
    _credentials: unknown,
    trackingNumbers: readonly string[],
  ): Promise<CourierResult<CourierTracking[]>> {
    if (this.down) return this.down;
    return {
      ok: true,
      value: trackingNumbers.flatMap((trackingNumber) => {
        const status = this.statuses.get(trackingNumber);
        return status === undefined ? [] : [{ trackingNumber, status }];
      }),
    };
  }

  async cancel(_credentials: unknown, trackingNumber: string): Promise<CourierResult<null>> {
    this.cancelled.push(trackingNumber);
    return { ok: true, value: null };
  }
}

describe.skipIf(!server)('Orders booked with couriers, and their parcels followed', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let variantId: string;
  let courier: ScriptedCourier;
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_settings']),
  };
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);

  const couriers = () => new Couriers([courier]);
  const bookings = () => new CourierBookingService(database, couriers());
  const fulfillments = () => new FulfillmentService(database, new StockService());
  const sweeper = () =>
    new CourierBookings({
      database,
      bookings: bookings(),
      accounts: new CourierAccountService(database, box, couriers()),
      couriers: couriers(),
      fulfillments: fulfillments(),
    });

  /** A confirmed order of a kurta, paid on delivery, to Lahore. */
  const confirmed = async (phone = '0300 1234567') => {
    const orders = workerOrders(database);
    const placed = unwrap(
      await orders.create(tenant, {
        lineItems: [{ variantId, quantity: 2 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone,
          address1: 'House 12, Street 4',
          address2: 'Gulberg III',
          city: 'Lahore',
        },
      }),
    );
    unwrap(await orders.confirm(tenant, placed.id));
    return placed;
  };

  const request = async (...orderIds: string[]) =>
    unwrap(await bookings().request(tenant, { orderIds })).bookings.map((booking) => booking.id);

  const state = async (id: string) => {
    const { rows } = await admin.query<{
      status: string;
      attempts: number;
      error: string | null;
      tracking_number: string | null;
      next_attempt_at: Date;
      next_track_at: Date | null;
      parcel_status: string | null;
      courier_status: string | null;
    }>(
      `SELECT status, attempts, error, tracking_number, next_attempt_at, next_track_at,
              parcel_status, courier_status
         FROM logistics.bookings WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  };

  const parcels = async (orderId: string) =>
    (
      await admin.query<{ status: string; tracking_company: string; tracking_number: string }>(
        `SELECT status, tracking_company, tracking_number FROM orders.fulfillments
          WHERE order_id = $1 ORDER BY shipped_at, id`,
        [orderId],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'courier-bookings-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shopId,
    ]);
    const product = unwrap(
      await new ProductService(database).create(tenant, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,000' }],
      }),
    );
    variantId = product.variants[0]!.id;
    const location = await new LocationService(database).primary(tenant);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 1_000 }],
      }),
    );
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(`
      DELETE FROM logistics.bookings;
      DELETE FROM logistics.courier_accounts;
      DELETE FROM logistics.courier_cities;`);
    courier = new ScriptedCourier();
    unwrap(
      await new CourierAccountService(database, box, couriers()).connect(tenant, {
        courier: 'scripted',
        credentials: [{ key: 'key', value: 'scripted-key-0001' }],
        pickupCode: 'LHR-7',
      }),
    );
  });

  it('books orders with their courier, and ships each with its number', async () => {
    await admin.query(
      `INSERT INTO logistics.courier_cities (courier, city, courier_city)
       VALUES ('scripted', 'Lahore', 'LHE')`,
    );
    const order = await confirmed();
    const [id] = await request(order.id);
    const at = new Date(Date.now() + 1_000);
    expect(await sweeper().sweep(at)).toEqual({ booked: 1, tracked: 0 });
    expect(courier.booked).toEqual([
      {
        reference: `#${order.number}`,
        customerName: 'Ayesha Khan',
        customerPhone: '03001234567',
        address: 'House 12, Street 4, Gulberg III',
        city: 'LHE',
        codAmount: 400_000n,
        pieces: 2,
        contents: 'Kurta x 2',
        weightGrams: null,
        pickupCode: 'LHR-7',
      },
    ]);
    expect(await parcels(order.id)).toEqual([
      { status: 'in_transit', tracking_company: 'Scripted', tracking_number: 'SC-1' },
    ]);
    expect(await state(id!)).toMatchObject({
      status: 'booked',
      attempts: 1,
      error: null,
      tracking_number: 'SC-1',
      parcel_status: 'booked',
      next_track_at: new Date(at.getTime() + TRACK_EVERY_MS.booked!),
    });
    const record = (await bookings().get(tenant, id!))!;
    expect(record).toMatchObject({ codAmount: 400_000n, bookedAt: at });
    // Once: nothing is due now.
    expect(await sweeper().sweep(at)).toEqual({ booked: 0, tracked: 0 });
    const { rows: events } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_events
        WHERE event_type IN ('fulfillment.created', 'courier_booking.booked')
        ORDER BY occurred_at, id`,
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'fulfillment.created',
      'courier_booking.booked',
    ]);
  });

  it('tries again while the courier cannot take it, for a day, and fails on what it refuses', async () => {
    const [down, refused] = [await confirmed(), await confirmed()];
    const [downId, refusedId] = await request(down.id, refused.id);
    courier.answers = [
      { ok: false, retry: true, message: 'Scripted could not be reached' },
      { ok: false, retry: false, message: 'Scripted: Invalid city' },
    ];
    const at = new Date(Date.now() + 1_000);
    expect(await sweeper().sweep(at)).toEqual({ booked: 0, tracked: 0 });
    expect(await state(downId!)).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'Scripted could not be reached',
      next_attempt_at: new Date(at.getTime() + 60_000),
    });
    expect(await state(refusedId!)).toMatchObject({
      status: 'failed',
      error: 'Scripted: Invalid city',
    });
    // Not before its time; then again, a while longer each time.
    expect(await sweeper().book(shopId, new Date(at.getTime() + 30_000))).toBe(0);
    courier.answers = [{ ok: false, retry: true, message: 'Scripted could not be reached' }];
    const second = new Date(at.getTime() + 60_000);
    await sweeper().book(shopId, second);
    expect(await state(downId!)).toMatchObject({
      attempts: 2,
      next_attempt_at: new Date(second.getTime() + 120_000),
    });
    // A day on, it fails.
    courier.answers = [{ ok: false, retry: true, message: 'Scripted could not be reached' }];
    await sweeper().book(shopId, new Date(Date.now() + BOOKING_GIVE_UP_MS));
    expect(await state(downId!)).toMatchObject({
      status: 'failed',
      error: 'Scripted could not be reached',
    });
    expect(await parcels(down.id)).toEqual([]);
  });

  it("cancels the courier's booking when the order changed, or the booking was cancelled, meanwhile", async () => {
    const orders = workerOrders(database);
    // Cancelled before it was booked: the courier is not asked.
    const gone = await confirmed();
    const [goneId] = await request(gone.id);
    unwrap(await orders.cancel(tenant, gone.id, { reason: 'customer' }));
    // Cancelled while the courier booked it.
    const racing = await confirmed();
    const [racingId] = await request(racing.id);
    // Its booking cancelled while the courier booked it.
    const withdrawn = await confirmed();
    const [withdrawnId] = await request(withdrawn.id);
    courier.answers = [
      async () => {
        unwrap(await orders.cancel(tenant, racing.id, { reason: 'customer' }));
        return { ok: true, value: { trackingNumber: 'SC-RACE' } };
      },
      async () => {
        unwrap(await bookings().cancel(tenant, withdrawnId!));
        return { ok: true, value: { trackingNumber: 'SC-GONE' } };
      },
    ];
    expect(await sweeper().sweep(new Date(Date.now() + 1_000))).toEqual({ booked: 0, tracked: 0 });
    expect(courier.booked.map((shipment) => shipment.reference)).toEqual([
      `#${racing.number}`,
      `#${withdrawn.number}`,
    ]);
    expect(await state(goneId!)).toMatchObject({
      status: 'failed',
      error: "A cancelled order can't be shipped",
    });
    expect(await state(racingId!)).toMatchObject({
      status: 'failed',
      tracking_number: 'SC-RACE',
      error: "A cancelled order can't be shipped; its booking SC-RACE with Scripted was cancelled",
    });
    expect(await state(withdrawnId!)).toMatchObject({ status: 'cancelled', tracking_number: null });
    expect(courier.cancelled).toEqual(['SC-RACE', 'SC-GONE']);
    expect(await parcels(withdrawn.id)).toEqual([]);
  });

  it('picks up where a try stopped once the courier had booked it', async () => {
    const unshipped = await confirmed();
    const shipped = await confirmed();
    const [unshippedId, shippedId] = await request(unshipped.id, shipped.id);
    await admin.query(
      `UPDATE logistics.bookings SET tracking_number = 'SC-' || order_number WHERE id = ANY($1)`,
      [[unshippedId, shippedId]],
    );
    unwrap(
      await fulfillments().fulfill(tenant, shipped.id, {
        tracking: { company: 'Scripted', number: `SC-${shipped.number}` },
      }),
    );
    expect(await sweeper().sweep(new Date(Date.now() + 1_000))).toEqual({ booked: 2, tracked: 0 });
    expect(courier.booked).toEqual([]);
    for (const order of [unshipped, shipped]) {
      expect(await parcels(order.id)).toEqual([
        {
          status: 'in_transit',
          tracking_company: 'Scripted',
          tracking_number: `SC-${order.number}`,
        },
      ]);
    }
    expect((await state(shippedId!)).status).toBe('booked');
  });

  it('follows booked parcels, marking them delivered or coming back as the courier says', async () => {
    const [first, second, third] = [await confirmed(), await confirmed(), await confirmed()];
    const ids = await request(first.id, second.id, third.id);
    const at = new Date(Date.now() + 1_000);
    expect(await sweeper().sweep(at)).toEqual({ booked: 3, tracked: 0 });

    courier.statuses.set('SC-1', 'Out For Delivery');
    courier.statuses.set('SC-2', 'Returning');
    let now = new Date(at.getTime() + TRACK_EVERY_MS.booked!);
    expect(await sweeper().sweep(now)).toEqual({ booked: 0, tracked: 2 });
    expect(await state(ids[0]!)).toMatchObject({
      parcel_status: 'out_for_delivery',
      courier_status: 'Out For Delivery',
      next_track_at: new Date(now.getTime() + TRACK_EVERY_MS.out_for_delivery!),
    });
    expect((await parcels(second.id))[0]!.status).toBe('returning');
    // Said nothing of: asked again later.
    expect(await state(ids[2]!)).toMatchObject({
      parcel_status: 'booked',
      next_track_at: new Date(now.getTime() + 3 * 3_600_000),
    });

    courier.statuses.set('SC-1', 'Delivered');
    now = new Date(now.getTime() + TRACK_EVERY_MS.out_for_delivery!);
    expect(await sweeper().sweep(now)).toEqual({ booked: 0, tracked: 1 });
    expect((await parcels(first.id))[0]!.status).toBe('delivered');
    expect(await state(ids[0]!)).toMatchObject({ parcel_status: 'delivered', next_track_at: null });

    // The courier down: asked again in an hour.
    courier.down = { ok: false, retry: true, message: 'Scripted could not be reached' };
    now = new Date(now.getTime() + 6 * 3_600_000);
    expect(await sweeper().sweep(now)).toEqual({ booked: 0, tracked: 0 });
    expect((await state(ids[2]!)).next_track_at).toEqual(new Date(now.getTime() + 3_600_000));
    const { rows: changes } = await admin.query<{
      id: string;
      event_type: string;
      aggregate_id: string;
      payload: ShipmentStatusChangedPayload;
      occurred_at: Date;
    }>(
      `SELECT id, event_type, aggregate_id, payload, occurred_at FROM platform.outbox_events
        WHERE event_type = 'shipment.status_changed' ORDER BY occurred_at, id`,
    );
    expect(changes.map((change) => change.payload.to)).toEqual([
      'out_for_delivery',
      'returning',
      'delivered',
    ]);

    // Each change a step of the parcel's way (ADR-160), heard twice and recorded once.
    const steps = new ParcelSteps(fulfillments());
    for (let time = 0; time < 2; time++) {
      for (const change of changes) {
        await steps.handle({
          id: change.id,
          type: change.event_type,
          shopId: tenant.shopId,
          aggregateType: 'courier_booking',
          aggregateId: change.aggregate_id,
          payload: change.payload as unknown as Record<string, unknown>,
          occurredAt: change.occurred_at.toISOString(),
        });
      }
    }
    const { rows: recorded } = await admin.query<{
      order_id: string;
      status: string;
      message: string;
      happened_at: Date;
    }>(
      `SELECT f.order_id, e.status, e.message, e.happened_at
         FROM orders.fulfillment_events e
         JOIN orders.fulfillments f ON f.shop_id = e.shop_id AND f.id = e.fulfillment_id
        ORDER BY e.happened_at, e.id`,
    );
    expect(recorded).toEqual(
      changes.map((change) => ({
        order_id: change.payload.orderId,
        status: STEP_OF[change.payload.to],
        message: change.payload.courierStatus,
        happened_at: change.occurred_at,
      })),
    );
    expect(recorded.map((step) => step.status)).toEqual([
      'out_for_delivery',
      'returning',
      'delivered',
    ]);
  });
});

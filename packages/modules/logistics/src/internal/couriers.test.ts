import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_LIMITS, TRACK_EVERY_MS, TRACK_FOR_MS } from './bookings.service.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

const TOKEN = 'pX7tokenLive0042abcd';

describe.skipIf(!server)("Shops' courier accounts and bookings", () => {
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
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  const postex = (name = 'PostEx Lahore') =>
    f.accounts.connect(f.a, {
      courier: 'postex',
      name,
      credentials: [{ key: 'token', value: TOKEN }],
      pickupCode: 'LHR-0042',
    });
  const testAccount = () =>
    f.accounts.connect(f.a, {
      courier: 'test',
      credentials: [{ key: 'key', value: 'anything-9876' }],
    });

  const bookings = async () =>
    (
      await f.admin.query<{
        order_id: string;
        status: string;
        error: string | null;
        attempts: number;
      }>('SELECT order_id, status, error, attempts FROM logistics.bookings ORDER BY created_at, id')
    ).rows;

  it('connects accounts, their credentials sealed for them alone, the first the default', async () => {
    expect(errorsOf(await f.accounts.connect(f.a, { courier: 'tcs' }))).toEqual([
      ['input.courier', 'INVALID'],
    ]);
    const blank = await f.accounts.connect(f.a, { courier: 'postex', credentials: [] });
    expect(blank.ok ? null : blank.errors[0]!.message).toBe('PostEx needs its API token');
    expect(
      errorsOf(
        await f.accounts.connect(f.a, {
          courier: 'postex',
          credentials: [
            { key: 'token', value: 'has spaces in it' },
            { key: 'password', value: 'x' },
          ],
        }),
      ),
    ).toEqual([
      ['input.credentials.0.value', 'INVALID'],
      ['input.credentials.1.key', 'INVALID'],
      ['input.credentials', 'BLANK'],
    ]);

    const lahore = unwrap(await postex());
    expect(lahore).toMatchObject({
      courier: 'postex',
      courierName: 'PostEx',
      name: 'PostEx Lahore',
      credentialsHint: 'abcd',
      pickupCode: 'LHR-0042',
      isDefault: true,
      archivedAt: null,
    });
    const tried = unwrap(await testAccount());
    expect(tried).toMatchObject({
      name: 'Test courier',
      credentialsHint: '9876',
      isDefault: false,
    });
    expect((await f.accounts.list(f.a)).map((account) => account.id)).toEqual([
      lahore.id,
      tried.id,
    ]);
    expect(await f.accounts.list(f.b)).toEqual([]);
    expect(await f.accounts.get(f.b, lahore.id)).toBeNull();

    // Sealed: the worker opens them; nothing else holds them in the clear.
    expect(await f.accounts.openedOf(f.a.shopId, lahore.id)).toEqual({
      id: lahore.id,
      courier: 'postex',
      credentials: { token: TOKEN },
      pickupCode: 'LHR-0042',
      archived: false,
    });
    const { rows: stored } = await f.admin.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM logistics.courier_accounts a
       UNION ALL SELECT details::text FROM platform.audit_log
       UNION ALL SELECT payload::text FROM platform.outbox_events`,
    );
    expect(stored.length).toBeGreaterThan(2);
    expect(stored.some((row) => row.text.includes(TOKEN))).toBe(false);
    // Bound to their account: copied onto another, they do not open.
    await f.admin.query(
      `UPDATE logistics.courier_accounts SET credentials =
         (SELECT credentials FROM logistics.courier_accounts WHERE id = $1)
        WHERE id = $2`,
      [lahore.id, tried.id],
    );
    await expect(f.accounts.openedOf(f.a.shopId, tried.id)).rejects.toThrow();

    const events = (await f.outbox())
      .filter((event) => event.event_type.startsWith('courier_account.'))
      .map((event) => [event.event_type, event.payload.courier]);
    expect(events).toEqual([
      ['courier_account.connected', 'postex'],
      ['courier_account.connected', 'test'],
    ]);
    const { rows: audit } = await f.admin.query<{
      action: string;
      details: { credentialsHint: string };
    }>('SELECT action, details FROM platform.audit_log ORDER BY occurred_at, id');
    expect(audit.map((entry) => [entry.action, entry.details.credentialsHint])).toEqual([
      ['courier_account.connected', 'abcd'],
      ['courier_account.connected', '9876'],
    ]);
  });

  it('changes accounts, and archives them, cancelling their bookings waiting', async () => {
    const lahore = unwrap(await postex());
    const karachi = unwrap(await postex('PostEx Karachi'));
    expect(karachi.isDefault).toBe(false);

    // The same credentials again change nothing.
    unwrap(
      await f.accounts.update(f.a, lahore.id, { credentials: [{ key: 'token', value: TOKEN }] }),
    );
    const renewed = unwrap(
      await f.accounts.update(f.a, lahore.id, {
        credentials: [{ key: 'token', value: 'pX7tokenLive0042wxyz' }],
        pickupCode: '',
      }),
    );
    expect(renewed).toMatchObject({ credentialsHint: 'wxyz', pickupCode: null });
    expect((await f.accounts.openedOf(f.a.shopId, lahore.id))!.credentials).toEqual({
      token: 'pX7tokenLive0042wxyz',
    });
    expect(errorsOf(await f.accounts.update(f.a, lahore.id, { isDefault: false }))).toEqual([
      ['input.isDefault', 'INVALID'],
    ]);
    expect(errorsOf(await f.accounts.update(f.a, lahore.id, { courier: 'test' }))).toEqual([
      ['input.courier', 'INVALID'],
    ]);
    unwrap(await f.accounts.update(f.a, karachi.id, { isDefault: true }));
    expect(
      (await f.accounts.list(f.a)).map((account) => [account.name, account.isDefault]),
    ).toEqual([
      ['PostEx Karachi', true],
      ['PostEx Lahore', false],
    ]);
    const updates = (await f.outbox())
      .filter((event) => event.event_type === 'courier_account.updated')
      .map((event) => event.payload.changed);
    expect(updates).toEqual([['credentials', 'pickupCode'], ['isDefault']]);

    // Archived: its bookings waiting are cancelled, and the default passes on.
    const order = await f.confirmed(f.a, kurta);
    unwrap(await f.bookings.request(f.a, { orderIds: [order.orderId] }));
    const archived = unwrap(await f.accounts.archive(f.a, karachi.id));
    expect(archived).toMatchObject({ isDefault: false });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await bookings()).toEqual([
      {
        order_id: order.orderId,
        status: 'cancelled',
        error: 'Its courier account was archived',
        attempts: 0,
      },
    ]);
    expect(
      (await f.accounts.list(f.a)).map((account) => [account.name, account.isDefault]),
    ).toEqual([['PostEx Lahore', true]]);
    expect(await f.accounts.list(f.a, { archived: true })).toHaveLength(2);
    expect(unwrap(await f.accounts.archive(f.a, karachi.id)).archivedAt).toEqual(
      archived.archivedAt,
    );
    expect(errorsOf(await f.accounts.update(f.a, karachi.id, { name: 'Again' }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(
      errorsOf(await f.bookings.request(f.a, { orderIds: [order.orderId], accountId: karachi.id })),
    ).toEqual([['accountId', 'INVALID']]);
    expect(errorsOf(await f.accounts.archive(f.b, lahore.id))).toEqual([['id', 'NOT_FOUND']]);
  });

  it('books orders each on its own, an order once at a time, whole', async () => {
    const order = await f.confirmed(f.a, kurta);
    expect(errorsOf(await f.bookings.request(f.a, { orderIds: [order.orderId] }))).toEqual([
      ['accountId', 'BLANK'],
    ]);
    const account = unwrap(await testAccount());
    expect(errorsOf(await f.bookings.request(f.a, { orderIds: [] }))).toEqual([
      ['orderIds', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await f.bookings.request(f.a, {
          orderIds: Array.from({ length: BOOKING_LIMITS.orders + 1 }, () => newId()),
        }),
      ),
    ).toEqual([['orderIds', 'TOO_MANY']]);

    const placed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 2 }],
        shippingAddress: {
          name: 'Bilal Ahmed',
          phone: '0321 7654321',
          address1: 'Flat 3, Block B',
          city: 'Karachi',
        },
      }),
    );
    const shipped = await f.shipped(f.a, kurta, { company: 'TCS', number: 'TCS-1001' });
    const part = await f.confirmed(f.a, kurta, { quantity: 2 });
    const [partLine] = (await f.orders.get(f.a, part.orderId))!.lines;
    unwrap(
      await f.fulfillments.fulfill(f.a, part.orderId, {
        lineItems: [{ id: partLine!.id, quantity: 1 }],
      }),
    );
    const missing = newId();
    const asked = unwrap(
      await f.bookings.request(f.a, {
        orderIds: [order.orderId, placed.id, shipped.orderId, part.orderId, missing, order.orderId],
      }),
    );
    expect(asked.bookings).toHaveLength(1);
    expect(asked.bookings[0]).toMatchObject({
      orderId: order.orderId,
      orderNumber: order.number,
      accountId: account.id,
      courier: 'test',
      courierName: 'Test courier',
      status: 'pending',
      attempts: 0,
      trackingNumber: null,
      parcelStatus: null,
      requestedBy: { kind: 'app', id: (f.a.actor as { tokenId: string }).tokenId },
    });
    expect(asked.refused).toEqual([
      {
        orderId: placed.id,
        message: 'Confirm the order with the customer before shipping it',
      },
      { orderId: shipped.orderId, message: 'Everything on this order has shipped' },
      {
        orderId: part.orderId,
        message: 'Part of this order has shipped: book the rest with the courier yourself',
      },
      { orderId: missing, message: 'Order not found' },
    ]);
    // Once at a time.
    expect(unwrap(await f.bookings.request(f.a, { orderIds: [order.orderId] })).refused).toEqual([
      { orderId: order.orderId, message: 'The order is waiting to be booked already' },
    ]);
    expect(errorsOf(await f.bookings.request(f.b, { orderIds: [order.orderId] }))).toEqual([
      ['accountId', 'BLANK'],
    ]);

    // Cancelled while it waits, then asked for again.
    const [first] = asked.bookings;
    expect(unwrap(await f.bookings.cancel(f.a, first!.id)).status).toBe('cancelled');
    expect(errorsOf(await f.bookings.cancel(f.a, first!.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.bookings.cancel(f.b, first!.id))).toEqual([['id', 'NOT_FOUND']]);
    const again = unwrap(await f.bookings.request(f.a, { orderIds: [order.orderId] }));
    expect(again.bookings).toHaveLength(1);

    const page = await f.bookings.list(f.a, { first: 1 });
    expect(page.items.map((booking) => booking.id)).toEqual([again.bookings[0]!.id]);
    expect(page.hasNextPage).toBe(true);
    const next = await f.bookings.list(f.a, {
      first: 1,
      after: { createdAt: page.items[0]!.createdAtExactly, id: page.items[0]!.id },
    });
    expect(next.items.map((booking) => booking.id)).toEqual([first!.id]);
    expect(next.hasNextPage).toBe(false);
    expect((await f.bookings.list(f.a, { first: 10, status: 'cancelled' })).items).toHaveLength(1);
    expect((await f.bookings.list(f.a, { first: 10, orderId: placed.id })).items).toHaveLength(0);
    expect((await f.bookings.list(f.b, { first: 10 })).items).toEqual([]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('courier_booking.'))
        .map((event) => event.event_type),
    ).toEqual([
      'courier_booking.requested',
      'courier_booking.cancelled',
      'courier_booking.requested',
    ]);
  });

  it('keeps what the worker does: claims, books, fails and follows', async () => {
    const account = unwrap(await postex());
    const order = await f.confirmed(f.a, kurta);
    const other = await f.confirmed(f.a, kurta);
    const [booking, failing] = unwrap(
      await f.bookings.request(f.a, { orderIds: [order.orderId, other.orderId] }),
    ).bookings;
    const at = new Date(Date.now() + 1_000);
    expect(await f.bookings.dueShops(at)).toEqual([f.a.shopId]);

    // Claimed for a lease, a try each time.
    const claimed = await f.bookings.claimToBook(f.a.shopId, at, 10, 60_000);
    expect(claimed.map((each) => [each.id, each.attempts, each.trackingNumber])).toEqual([
      [booking!.id, 1, null],
      [failing!.id, 1, null],
    ]);
    expect(await f.bookings.claimToBook(f.a.shopId, at, 10, 60_000)).toEqual([]);
    const later = new Date(at.getTime() + 60_000);
    expect(
      (await f.bookings.claimToBook(f.a.shopId, later, 10, 60_000)).map((each) => each.attempts),
    ).toEqual([2, 2]);

    // The courier's number kept first; then the parcel it shipped as.
    expect(
      await f.bookings.recordTrackingNumber(f.a.shopId, booking!.id, 'CX-100200', 200_000n),
    ).toBe(true);
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill({ shopId: f.a.shopId, actor: 'system' }, order.orderId, {
        tracking: { company: 'PostEx', number: 'CX-100200' },
      }),
    );
    await f.bookings.markBooked(f.a.shopId, booking!.id, { fulfillmentId, at: later });
    let record = (await f.bookings.get(f.a, booking!.id))!;
    expect(record).toMatchObject({
      status: 'booked',
      trackingNumber: 'CX-100200',
      codAmount: 200_000n,
      fulfillmentId,
      parcelStatus: 'booked',
      error: null,
    });
    expect(record.bookedAt).toEqual(later);
    // No more than once: it is booked now.
    await f.bookings.markFailed(f.a.shopId, booking!.id, 'Too late');
    expect((await f.bookings.get(f.a, booking!.id))!.status).toBe('booked');

    await f.bookings.retryLater(f.a.shopId, failing!.id, 'PostEx could not be reached', later);
    await f.bookings.markFailed(f.a.shopId, failing!.id, 'PostEx: Invalid city');
    expect(await f.bookings.get(f.a, failing!.id)).toMatchObject({
      status: 'failed',
      error: 'PostEx: Invalid city',
    });

    // Followed as often as where it is calls for.
    const tracking = async (said: string, at: Date) => {
      const [due] = await f.bookings.claimToTrack(f.a.shopId, at, 10, 60_000);
      expect(due).toBeDefined();
      const changed = await f.bookings.recordTracking(f.a.shopId, due!, {
        courierStatus: said,
        at,
      });
      record = (await f.bookings.get(f.a, booking!.id))!;
      const { rows } = await f.admin.query<{ next_track_at: Date | null }>(
        'SELECT next_track_at FROM logistics.bookings WHERE id = $1',
        [booking!.id],
      );
      return { changed, next: rows[0]!.next_track_at };
    };
    expect(await f.bookings.claimToTrack(f.a.shopId, later, 10, 60_000)).toEqual([]);
    let now = new Date(later.getTime() + TRACK_EVERY_MS.booked!);
    // PostEx's words, by its mapping.
    let told = await tracking('PostEx WareHouse', now);
    expect(told.changed).toEqual({ from: 'booked', to: 'in_transit' });
    expect(told.next).toEqual(new Date(now.getTime() + TRACK_EVERY_MS.in_transit!));
    expect(record).toMatchObject({ courierStatus: 'PostEx WareHouse', parcelStatus: 'in_transit' });
    // Words no mapping knows leave it where it was.
    now = told.next!;
    told = await tracking('Shipment Weighed', now);
    expect(told.changed).toEqual({ from: 'in_transit', to: 'in_transit' });
    expect(record).toMatchObject({ courierStatus: 'Shipment Weighed', parcelStatus: 'in_transit' });
    // Hatti's own words, without a mapping.
    now = told.next!;
    told = await tracking('Out For Delivery', now);
    expect(told.next).toEqual(new Date(now.getTime() + TRACK_EVERY_MS.out_for_delivery!));
    now = told.next!;
    told = await tracking('Delivered', now);
    expect(told.changed).toEqual({ from: 'out_for_delivery', to: 'delivered' });
    expect(told.next).toBeNull();
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'shipment.status_changed')
        .map((event) => [event.payload.from, event.payload.to, event.payload.courierStatus]),
    ).toEqual([
      ['booked', 'in_transit', 'PostEx WareHouse'],
      ['in_transit', 'out_for_delivery', 'Out For Delivery'],
      ['out_for_delivery', 'delivered', 'Delivered'],
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'courier_booking.booked')
        .map((event) => [event.aggregate_id, event.payload.trackingNumber]),
    ).toEqual([[booking!.id, 'CX-100200']]);

    // Followed sixty days at most.
    await f.admin.query(
      `UPDATE logistics.bookings SET parcel_status = 'in_transit', next_track_at = now(),
              booked_at = now() - $2::interval
        WHERE id = $1`,
      [booking!.id, `${TRACK_FOR_MS - 3_600_000} milliseconds`],
    );
    told = await tracking('En-Route to PostEx warehouse', new Date());
    expect(told.next).toBeNull();

    // Cities as the courier names them, where it names them otherwise.
    await f.admin.query(
      `INSERT INTO logistics.courier_cities (courier, city, courier_city)
       VALUES ('postex', 'Rawalpindi', 'Rawalpindi Cantt')`,
    );
    expect(await f.bookings.courierCityOf(f.a.shopId, account.courier, 'rawalpindi')).toBe(
      'Rawalpindi Cantt',
    );
    expect(await f.bookings.courierCityOf(f.a.shopId, account.courier, 'Lahore')).toBe('Lahore');
  });

  it("reads Leopards' words by its mapping, its key and password both asked for (ADR-162)", async () => {
    expect(
      errorsOf(
        await f.accounts.connect(f.a, {
          courier: 'leopards',
          credentials: [{ key: 'apiKey', value: 'LK-7d1f0042' }],
        }),
      ),
    ).toEqual([['input.credentials', 'BLANK']]);
    const account = unwrap(
      await f.accounts.connect(f.a, {
        courier: 'leopards',
        credentials: [
          { key: 'apiPassword', value: 'Lp@ss-9931' },
          { key: 'apiKey', value: 'LK-7d1f0042' },
        ],
        pickupCode: '1234',
      }),
    );
    // The key gives the hint, never the password.
    expect(account).toMatchObject({
      courier: 'leopards',
      courierName: 'Leopards',
      credentialsHint: '0042',
      pickupCode: '1234',
      isDefault: true,
    });

    const order = await f.confirmed(f.a, kurta);
    const [booking] = unwrap(await f.bookings.request(f.a, { orderIds: [order.orderId] })).bookings;
    const at = new Date(Date.now() + 1_000);
    expect(await f.bookings.claimToBook(f.a.shopId, at, 10, 60_000)).toHaveLength(1);
    await f.bookings.recordTrackingNumber(f.a.shopId, booking!.id, 'LE7522377485', 200_000n);
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill({ shopId: f.a.shopId, actor: 'system' }, order.orderId, {
        tracking: { company: 'Leopards', number: 'LE7522377485' },
      }),
    );
    await f.bookings.markBooked(f.a.shopId, booking!.id, { fulfillmentId, at });
    const heard: (string | null)[] = [];
    let now = at;
    for (const said of [
      'Consignment Booked',
      'Arrived at Station',
      'Assign to Courier',
      'Pending',
      'Being Return',
      'Returned to Shipper',
    ]) {
      await f.admin.query('UPDATE logistics.bookings SET next_track_at = $2 WHERE id = $1', [
        booking!.id,
        now,
      ]);
      const [due] = await f.bookings.claimToTrack(f.a.shopId, now, 10, 60_000);
      await f.bookings.recordTracking(f.a.shopId, due!, { courierStatus: said, at: now });
      heard.push((await f.bookings.get(f.a, booking!.id))!.parcelStatus);
      now = new Date(now.getTime() + 60_000);
    }
    expect(heard).toEqual([
      'booked',
      'in_transit',
      'out_for_delivery',
      'attempted',
      'returning',
      'returned',
    ]);
  });
});

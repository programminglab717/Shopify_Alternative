import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OrderShipmentFacts } from '@hatti/orders/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COURIER_CITIES_RETRY_MS,
  COURIER_CITIES_TTL_MS,
  Couriers,
  PostExCourier,
  TestCourier,
  plainStatusOf,
  type CourierShipment,
} from './couriers.js';
import { courierShipmentOf } from './shipments.js';

/** What the fake PostEx was asked. */
interface Asked {
  method: string;
  url: string;
  token: string | undefined;
  body: Record<string, unknown> | null;
}

const SHIPMENT: CourierShipment = {
  reference: '#1043',
  customerName: 'Ayesha Khan',
  customerPhone: '03001234567',
  address: 'House 12, Street 4, Gulberg III, near Liberty Market',
  city: 'Lahore',
  codAmount: 200_050n,
  pieces: 3,
  contents: 'Kurta - Red x 2, Dupatta',
  weightGrams: 900,
  pickupCode: 'LHR-0042',
};

describe('PostEx', () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  /** How the fake answers each request, in turn; 200 with no tracking number when none is left. */
  let answers: { status: number; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({
          method: request.method ?? '',
          url: request.url ?? '',
          token: request.headers.token as string | undefined,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        });
        const answer = answers.shift() ?? { status: 200, body: { statusCode: '200' } };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/order/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    asked.length = 0;
    answers = [];
  });

  const postex = () => new PostExCourier({ baseUrl, timeoutMs: 2_000 });
  const credentials = { token: 'pX7tokenLive0042abcd' };

  it('books a parcel, its token in a header, what the order owes in whole rupees', async () => {
    answers = [
      {
        status: 200,
        body: {
          statusCode: '200',
          statusMessage: 'ORDER HAS BEEN CREATED',
          dist: { trackingNumber: ' CX-1234567 ', orderStatus: 'Unbooked' },
        },
      },
    ];
    expect(await postex().book(credentials, SHIPMENT)).toEqual({
      ok: true,
      value: { trackingNumber: 'CX-1234567' },
    });
    expect(asked).toEqual([
      {
        method: 'POST',
        url: '/api/order/v3/create-order',
        token: credentials.token,
        body: {
          orderRefNumber: '#1043',
          invoicePayment: 2_001,
          orderDetail: 'Kurta - Red x 2, Dupatta',
          customerName: 'Ayesha Khan',
          customerPhone: '03001234567',
          deliveryAddress: 'House 12, Street 4, Gulberg III, near Liberty Market',
          cityName: 'Lahore',
          invoiceDivision: 1,
          items: 3,
          orderType: 'Normal',
          pickupAddressCode: 'LHR-0042',
        },
      },
    ]);
    // Nothing to collect on an order paid ahead; the account's own pickup address unless given.
    await postex().book(credentials, { ...SHIPMENT, codAmount: 0n, pickupCode: null });
    expect(asked[1]!.body).toMatchObject({ invoicePayment: 0 });
    expect(asked[1]!.body).not.toHaveProperty('pickupAddressCode');
  });

  it('says why PostEx refused, and whether trying again may go otherwise', async () => {
    answers = [
      { status: 400, body: { statusCode: '400', statusMessage: 'Invalid City Name' } },
      { status: 200, body: { statusCode: '401', statusMessage: 'Unauthorized token' } },
      { status: 503, body: { statusCode: '503', statusMessage: 'Service Unavailable' } },
      { status: 429, body: {} },
      { status: 502, body: '<html>Bad gateway</html>' },
      { status: 200, body: { statusCode: '200', dist: {} } },
    ];
    const tries = [];
    for (let i = answers.length; i > 0; i--) tries.push(await postex().book(credentials, SHIPMENT));
    expect(tries).toEqual([
      { ok: false, retry: false, message: 'PostEx: Invalid City Name' },
      { ok: false, retry: false, message: 'PostEx: Unauthorized token' },
      { ok: false, retry: true, message: 'PostEx: Service Unavailable' },
      { ok: false, retry: true, message: 'PostEx: it answered 429' },
      { ok: false, retry: true, message: 'PostEx: it answered 502' },
      { ok: false, retry: false, message: 'PostEx booked the order without a tracking number' },
    ]);
    const unreachable = await new PostExCourier({
      baseUrl: 'http://127.0.0.1:9/api/order',
      timeoutMs: 1_000,
    }).book(credentials, SHIPMENT);
    expect(unreachable).toMatchObject({ ok: false, retry: true });
    expect(unreachable.ok ? '' : unreachable.message).toMatch(/^PostEx could not be reached: /);
  });

  it('tracks parcels one by one, leaving out those it does not know', async () => {
    answers = [
      { status: 200, body: { statusCode: '200', dist: { transactionStatus: 'Out For Delivery' } } },
      { status: 400, body: { statusCode: '400', statusMessage: 'Invalid tracking number' } },
      {
        status: 200,
        body: {
          statusCode: '200',
          dist: {
            transactionStatusHistory: [
              { transactionStatusMessage: 'Booked' },
              { transactionStatusMessage: 'PostEx WareHouse' },
            ],
          },
        },
      },
    ];
    expect(await postex().track(credentials, ['CX-1', 'CX-2', 'CX 3'])).toEqual({
      ok: true,
      value: [
        { trackingNumber: 'CX-1', status: 'Out For Delivery' },
        { trackingNumber: 'CX 3', status: 'PostEx WareHouse' },
      ],
    });
    expect(asked.map((each) => [each.method, each.url, each.token])).toEqual([
      ['GET', '/api/order/v1/track-order/CX-1', credentials.token],
      ['GET', '/api/order/v1/track-order/CX-2', credentials.token],
      ['GET', '/api/order/v1/track-order/CX%203', credentials.token],
    ]);
    // PostEx down, or refusing the account, stops the round.
    answers = [{ status: 500, body: {} }];
    expect(await postex().track(credentials, ['CX-1', 'CX-2'])).toMatchObject({
      ok: false,
      retry: true,
    });
    answers = [{ status: 401, body: { statusMessage: 'Unauthorized' } }];
    expect(await postex().track(credentials, ['CX-1', 'CX-2'])).toEqual({
      ok: false,
      retry: false,
      message: 'PostEx: Unauthorized',
    });
    expect(asked).toHaveLength(5);
  });

  it('cancels a booking', async () => {
    expect(await postex().cancel(credentials, 'CX-1234567')).toEqual({ ok: true, value: null });
    expect(asked).toEqual([
      {
        method: 'PUT',
        url: '/api/order/v1/cancel-order',
        token: credentials.token,
        body: { trackingNumber: 'CX-1234567' },
      },
    ]);
  });

  it("hands parcels over through PostEx's load sheet, which it answers as a PDF (ADR-253)", async () => {
    const sheet = '%PDF-1.4\n% PostEx load sheet\n%%EOF\n';
    answers = [{ status: 200, body: sheet }];
    const taken = await postex().pickup(credentials, {
      trackingNumbers: ['CX-1234567', 'CX-1234568'],
      pickupCode: 'LHR-0042',
      rider: null,
    });
    expect(taken.ok && taken.value.reference).toBeNull();
    expect(taken.ok && taken.value.document?.toString('latin1')).toBe(sheet);
    expect(asked).toEqual([
      {
        method: 'POST',
        url: '/api/order/v2/generate-load-sheet',
        token: credentials.token,
        body: { trackingNumbers: ['CX-1234567', 'CX-1234568'], pickupAddress: 'LHR-0042' },
      },
    ]);
    // The account's own pickup address unless given; why PostEx refused, as it says it in JSON.
    answers = [
      { status: 400, body: { statusCode: '400', statusMessage: 'Invalid tracking number' } },
      { status: 200, body: { statusCode: '200', dist: null } },
      { status: 503, body: '<html>Service Unavailable</html>' },
    ];
    const ask = () =>
      postex().pickup(credentials, { trackingNumbers: ['CX-9'], pickupCode: null, rider: null });
    expect(await ask()).toEqual({
      ok: false,
      retry: false,
      message: 'PostEx: Invalid tracking number',
    });
    expect(asked[1]!.body).toEqual({ trackingNumbers: ['CX-9'] });
    expect(await ask()).toEqual({
      ok: false,
      retry: false,
      message: 'PostEx: it gave no load sheet',
    });
    expect(await ask()).toEqual({ ok: false, retry: true, message: 'PostEx: it answered 503' });
  });

  it('lists the cities PostEx delivers to, once a day, keeping them while it cannot say (ADR-233)', async () => {
    const courier = postex();
    const operational = {
      status: 200,
      body: {
        statusCode: '200',
        statusMessage: 'SUCCESSFULLY OPERATED',
        dist: [
          { operationalCityName: 'Lahore', isPickupCity: true, isDeliveryCity: true },
          { operationalCityName: ' Rawalpindi ', isPickupCity: false, isDeliveryCity: true },
          { operationalCityName: 'Gwadar', isPickupCity: false, isDeliveryCity: false },
          { operationalCityName: 'LAHORE', isDeliveryCity: true },
          { operationalCityName: 'Hub' },
          { operationalCityName: '' },
        ],
      },
    };
    const listed = { ok: true, value: ['Lahore', 'Rawalpindi', 'Hub'] };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = new Date('2027-03-01T09:00:00Z').getTime();
      vi.setSystemTime(at);
      answers = [operational];
      expect(await courier.cities(credentials)).toEqual(listed);
      expect(asked).toEqual([
        {
          method: 'GET',
          url: '/api/order/v2/get-operational-city',
          token: credentials.token,
          body: null,
        },
      ]);
      vi.setSystemTime(at + COURIER_CITIES_TTL_MS);
      expect(await courier.cities(credentials)).toEqual(listed);
      expect(asked).toHaveLength(1);
      // A day on, it is asked again; while it cannot say, those it gave last stand, and it is
      // not asked again for five minutes.
      const later = at + COURIER_CITIES_TTL_MS + 1;
      vi.setSystemTime(later);
      answers = [
        { status: 503, body: { statusCode: '503', statusMessage: 'Service Unavailable' } },
      ];
      expect(await courier.cities(credentials)).toEqual(listed);
      vi.setSystemTime(later + COURIER_CITIES_RETRY_MS);
      expect(await courier.cities(credentials)).toEqual(listed);
      expect(asked).toHaveLength(2);
      vi.setSystemTime(later + COURIER_CITIES_RETRY_MS + 1);
      answers = [operational];
      expect(await courier.cities(credentials)).toEqual(listed);
      expect(asked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }

    // Never given any: why not, and whether trying again may go otherwise.
    answers = [{ status: 503, body: { statusCode: '503', statusMessage: 'Service Unavailable' } }];
    const fresh = postex();
    const down = { ok: false, retry: true, message: 'PostEx: Service Unavailable' };
    expect(await fresh.cities(credentials)).toEqual(down);
    expect(await fresh.cities(credentials)).toEqual(down);
    expect(asked).toHaveLength(4);
    answers = [{ status: 200, body: { statusCode: '200', dist: [] } }];
    expect(await postex().cities(credentials)).toEqual({
      ok: false,
      retry: true,
      message: 'PostEx gave no cities to deliver to',
    });
  });
});

describe('Couriers', () => {
  const order: OrderShipmentFacts = {
    id: 'order-1',
    number: 1043,
    name: '#1043',
    address: {
      name: 'Ayesha Khan',
      phone: '+923001234567',
      address1: 'House 12, Street 4',
      address2: 'Gulberg III',
      landmark: 'near Liberty Market',
      city: 'Lahore',
      provinceCode: 'PB',
      zip: null,
    },
    codAmount: 200_050n,
    currency: 'PKR',
    items: [
      { title: 'Kurta - Red', quantity: 2 },
      { title: 'Dupatta', quantity: 1 },
    ],
    weightGrams: 900,
    parcels: [],
    refusal: null,
  };

  it('asks for the parcel an order makes: its customer, address, cash and contents', () => {
    expect(courierShipmentOf(order, { city: 'Lahore', pickupCode: 'LHR-0042' })).toEqual(SHIPMENT);
    expect(
      courierShipmentOf(
        { ...order, address: { ...order.address!, address2: null, landmark: ' ' } },
        { city: 'Lahore', pickupCode: null },
      ),
    ).toMatchObject({ address: 'House 12, Street 4', pickupCode: null });
    expect(courierShipmentOf({ ...order, address: null }, { city: '', pickupCode: null })).toEqual({
      refusal: "The customer's details on this order were erased at their request",
    });
    expect(
      courierShipmentOf(
        { ...order, address: { ...order.address!, phone: '+924235761234' } },
        { city: 'Lahore', pickupCode: null },
      ),
    ).toEqual({ refusal: "The customer's number is not a mobile number couriers take" });
  });

  it('reads statuses written as Hatti names its own', () => {
    expect(plainStatusOf('Out For Delivery')).toBe('out_for_delivery');
    expect(plainStatusOf(' delivered ')).toBe('delivered');
    expect(plainStatusOf('In-Transit')).toBe('in_transit');
    expect(plainStatusOf('PostEx WareHouse')).toBeNull();
  });

  it('lists couriers by name, and books nothing with the test courier', async () => {
    const test = new TestCourier();
    const couriers = new Couriers([new PostExCourier(), test]);
    expect(couriers.list.map((info) => [info.courier, info.name, info.test])).toEqual([
      ['postex', 'PostEx', false],
      ['test', 'Test courier', true],
    ]);
    expect(couriers.of('tcs')).toBeNull();
    const booked = await test.book({ key: 'x' }, SHIPMENT);
    const trackingNumber = booked.ok ? booked.value.trackingNumber : '';
    expect(trackingNumber).toMatch(/^HT\d{10}$/);
    expect(test.booked).toEqual([SHIPMENT]);
    test.set(trackingNumber, 'Out For Delivery');
    expect(await test.track({ key: 'x' }, [trackingNumber, 'HT0'])).toEqual({
      ok: true,
      value: [{ trackingNumber, status: 'Out For Delivery' }],
    });
    expect(await test.cancel({ key: 'x' }, trackingNumber)).toEqual({ ok: true, value: null });
    expect(await test.cancel({ key: 'x' }, 'HT0')).toMatchObject({ ok: false, retry: false });
    // Pickups through each API; Leopards' names its rider (ADR-253).
    expect(couriers.list.map((info) => [info.courier, info.pickups])).toEqual([
      ['postex', { rider: false }],
      ['test', { rider: false }],
    ]);
    const pickup = { trackingNumbers: [trackingNumber], pickupCode: null, rider: null };
    const taken = await test.pickup({ key: 'x' }, pickup);
    expect(taken.ok && taken.value.reference).toBe('HTL000001');
    expect(test.pickups).toEqual([pickup]);
  });
});

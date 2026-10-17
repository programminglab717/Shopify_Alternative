import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TraxCourier, type CourierShipment } from './couriers.js';

/** What the fake Trax was asked. */
interface Asked {
  method: string;
  url: string;
  authorization: string | undefined;
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
  pickupCode: null,
};

const CITIES = {
  status: 0,
  message: 'Success',
  cities: [
    { id: 202, name: 'LAHORE' },
    { id: 7, name: 'Dera Ghazi Khan' },
    { id: 8, name: ' ' },
  ],
};

describe('Trax (SHP-01, ADR-510)', () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  /** How the fake answers each request, in turn; `status: 0` and nothing more when none is left. */
  let answers: { status: number; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        });
        const answer = answers.shift() ?? { status: 200, body: { status: 0, message: 'Success' } };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    asked.length = 0;
    answers = [];
  });

  const trax = () => new TraxCourier({ baseUrl, timeoutMs: 2_000, today: () => '2026-10-17' });
  const credentials = { apiKey: 'tx-9f1e7c2a', pickupAddressId: '5521' };

  it("books a parcel to Trax's ID for its city, its key in the Authorization header", async () => {
    const courier = trax();
    answers = [
      { status: 200, body: CITIES },
      { status: 200, body: { status: 0, message: 'Booked', tracking_number: 101_045_221_903 } },
    ];
    expect(await courier.book(credentials, SHIPMENT)).toEqual({
      ok: true,
      value: { trackingNumber: '101045221903' },
    });
    expect(asked).toEqual([
      { method: 'GET', url: '/api/cities', authorization: 'tx-9f1e7c2a', body: null },
      {
        method: 'POST',
        url: '/api/shipment/book',
        authorization: 'tx-9f1e7c2a',
        body: {
          service_type_id: 1,
          pickup_address_id: 5521,
          information_display: 1,
          consignee_city_id: 202,
          consignee_name: 'Ayesha Khan',
          consignee_address: 'House 12, Street 4, Gulberg III, near Liberty Market',
          consignee_phone_number_1: '03001234567',
          consignee_email_address: '',
          order_id: '#1043',
          item_product_type_id: 1,
          item_description: 'Kurta - Red x 2, Dupatta',
          item_quantity: 3,
          item_insurance: 0,
          pickup_date: '2026-10-17',
          estimated_weight: 0.9,
          shipping_mode_id: 1,
          amount: 2_001,
          payment_mode_id: 1,
          charges_mode_id: 4,
        },
      },
    ]);

    // Its cities are asked for once a day; a city written otherwise is the same city. Nothing to
    // collect on an order paid ahead, a parcel without a weight its first half kilo, another
    // pickup address where the account gives one.
    asked.length = 0;
    answers = [{ status: 200, body: { status: 0, tracking_number: 'TX77' } }];
    expect(
      await courier.book(credentials, {
        ...SHIPMENT,
        city: 'dera ghazi  khan',
        codAmount: 0n,
        weightGrams: null,
        pickupCode: ' 6610 ',
      }),
    ).toEqual({ ok: true, value: { trackingNumber: 'TX77' } });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toMatchObject({
      consignee_city_id: 7,
      pickup_address_id: 6610,
      amount: 0,
      payment_mode_id: 4,
      estimated_weight: 0.5,
    });

    // A city Trax does not deliver to is refused before anything is booked.
    asked.length = 0;
    expect(await courier.book(credentials, { ...SHIPMENT, city: 'Gwadar' })).toEqual({
      ok: false,
      retry: false,
      message: 'Trax does not deliver to Gwadar',
    });
    expect(asked).toEqual([]);
  });

  it('says what Trax refused, and tries again only when it could not answer', async () => {
    const courier = trax();
    answers = [
      { status: 200, body: CITIES },
      {
        status: 200,
        body: {
          status: 1,
          message: 'Validation failed',
          errors: { consignee_phone_number_1: ['Invalid phone'] },
        },
      },
    ];
    expect(await courier.book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: false,
      message: 'Trax: Invalid phone',
    });
    answers = [{ status: 502, body: 'Bad Gateway' }];
    expect(await courier.book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: true,
      message: 'Trax: it answered 502',
    });
    answers = [{ status: 200, body: { status: 0, message: 'Booked' } }];
    expect(await courier.book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: false,
      message: 'Trax booked the parcel without a tracking number',
    });
    answers = [{ status: 200, body: { status: 0, cities: [] } }];
    expect(await trax().cities(credentials)).toEqual({
      ok: false,
      retry: true,
      message: 'Trax gave no cities to deliver to',
    });
  });

  it('tracks each parcel by its latest status, leaving out those Trax does not know', async () => {
    answers = [
      {
        status: 200,
        body: {
          status: 0,
          details: {
            tracking_history: [
              { status: 'Shipment - Arrived at Origin', date_time: '2026-10-16 09:10:00' },
              { status: ' Shipment - Out for Delivery ', date_time: '2026-10-17 08:30:00' },
              { status: 'Shipment - Booked', date_time: '2026-10-15 18:00:00' },
            ],
          },
        },
      },
      { status: 200, body: { status: 1, message: 'Invalid tracking number' } },
      { status: 200, body: { status: 0, details: { tracking_history: [] } } },
    ];
    expect(await trax().track(credentials, ['TX1', 'TX2', 'TX3'])).toEqual({
      ok: true,
      value: [{ trackingNumber: 'TX1', status: 'Shipment - Out for Delivery' }],
    });
    expect(asked.map((each) => `${each.method} ${each.url}`)).toEqual([
      'GET /api/shipment/track?tracking_number=TX1&type=0',
      'GET /api/shipment/track?tracking_number=TX2&type=0',
      'GET /api/shipment/track?tracking_number=TX3&type=0',
    ]);

    // An account Trax refuses stops the round.
    answers = [{ status: 401, body: { status: 1, message: 'Unauthenticated.' } }];
    expect(await trax().track(credentials, ['TX1', 'TX2'])).toEqual({
      ok: false,
      retry: false,
      message: 'Trax: Unauthenticated.',
    });
  });

  it('cancels a booking', async () => {
    expect(await trax().cancel(credentials, 'TX1')).toEqual({ ok: true, value: null });
    expect(asked).toEqual([
      {
        method: 'POST',
        url: '/api/shipment/cancel',
        authorization: 'tx-9f1e7c2a',
        body: { tracking_number: 'TX1' },
      },
    ]);
    answers = [{ status: 200, body: { status: 1, message: 'Shipment already picked up' } }];
    expect(await trax().cancel(credentials, 'TX1')).toEqual({
      ok: false,
      retry: false,
      message: 'Trax: Shipment already picked up',
    });
  });
});

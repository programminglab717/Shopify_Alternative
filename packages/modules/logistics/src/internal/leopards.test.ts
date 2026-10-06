import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeopardsCourier, type CourierShipment } from './couriers.js';

/** What the fake Leopards was asked. */
interface Asked {
  method: string;
  url: string;
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
  pickupCode: '1234',
};

const CITIES = {
  status: 1,
  error: 0,
  city_list: [
    { id: 789, name: 'LAHORE', allow_as_origin: true, allow_as_destination: true },
    { id: 202, name: 'Dera Ghazi Khan', allow_as_origin: true, allow_as_destination: true },
    { id: 475, name: 'Quetta', allow_as_origin: true, allow_as_destination: '0' },
  ],
};

describe('Leopards', () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  /** How the fake answers each request, in turn; `status: 1` and nothing more when none is left. */
  let answers: { status: number; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        });
        const answer = answers.shift() ?? { status: 200, body: { status: 1, error: 0 } };
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

  const leopards = () => new LeopardsCourier({ baseUrl, timeoutMs: 2_000 });
  const credentials = { apiKey: 'LK-7d1f0042', apiPassword: 'Lp@ss-9931' };
  const signed = { api_key: credentials.apiKey, api_password: credentials.apiPassword };

  it("books a parcel to Leopards' ID for its city, its key and password in the body", async () => {
    const courier = leopards();
    answers = [
      { status: 200, body: CITIES },
      {
        status: 200,
        body: {
          status: 1,
          error: 0,
          track_number: ' LE7522377485 ',
          slip_link: 'https://merchantapi.leopardscourier.com/slip/LE7522377485',
        },
      },
    ];
    expect(await courier.book(credentials, SHIPMENT)).toEqual({
      ok: true,
      value: { trackingNumber: 'LE7522377485' },
    });
    expect(asked).toEqual([
      { method: 'POST', url: '/api/getAllCities/format/json/', body: signed },
      {
        method: 'POST',
        url: '/api/bookPacket/format/json/',
        body: {
          ...signed,
          booked_packet_weight: 900,
          booked_packet_no_piece: 3,
          booked_packet_collect_amount: 2_001,
          booked_packet_order_id: '#1043',
          origin_city: 'self',
          destination_city: 789,
          shipment_id: 1234,
          shipment_name_eng: 'self',
          shipment_email: 'self',
          shipment_phone: 'self',
          shipment_address: 'self',
          consignment_name_eng: 'Ayesha Khan',
          consignment_phone: '03001234567',
          consignment_address: 'House 12, Street 4, Gulberg III, near Liberty Market',
          special_instructions: 'Kurta - Red x 2, Dupatta',
        },
      },
    ]);

    // Its cities are asked for once a day; a city written otherwise is the same city. Nothing to
    // collect on an order paid ahead, a parcel without a weight its first half kilo, and the
    // account's own shipper unless one is given.
    answers = [{ status: 200, body: { status: 1, track_number: 'LE7522377486' } }];
    await courier.book(credentials, {
      ...SHIPMENT,
      city: 'Dera Ghazi-Khan',
      codAmount: 0n,
      weightGrams: null,
      pickupCode: null,
    });
    expect(asked).toHaveLength(3);
    expect(asked[2]!.body).toMatchObject({
      destination_city: 202,
      booked_packet_collect_amount: 0,
      booked_packet_weight: 500,
    });
    expect(asked[2]!.body).not.toHaveProperty('shipment_id');

    // Cities it does not deliver to, or has not heard of, are not booked.
    for (const city of ['Quetta', 'Sukkur']) {
      expect(await courier.book(credentials, { ...SHIPMENT, city })).toEqual({
        ok: false,
        retry: false,
        message: `Leopards does not deliver to ${city}`,
      });
    }
    expect(asked).toHaveLength(3);
  });

  it('lists the cities Leopards delivers to as its list names them, the list its bookings use (ADR-233)', async () => {
    const courier = leopards();
    answers = [{ status: 200, body: CITIES }];
    expect(await courier.cities(credentials)).toEqual({
      ok: true,
      value: ['LAHORE', 'Dera Ghazi Khan'],
    });
    answers = [{ status: 200, body: { status: 1, track_number: 'LE7522377485' } }];
    expect(await courier.book(credentials, SHIPMENT)).toMatchObject({ ok: true });
    expect(asked.map((each) => each.url)).toEqual([
      '/api/getAllCities/format/json/',
      '/api/bookPacket/format/json/',
    ]);
    answers = [{ status: 200, body: { status: 0, error: 'Invalid API Key' } }];
    expect(await leopards().cities(credentials)).toEqual({
      ok: false,
      retry: false,
      message: 'Leopards: Invalid API Key',
    });
  });

  it('says why Leopards refused, and whether trying again may go otherwise', async () => {
    // Its list of cities, asked for with the account's key, refused with it.
    answers = [{ status: 200, body: { status: 0, error: 'Invalid API Key or Password' } }];
    expect(await leopards().book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: false,
      message: 'Leopards: Invalid API Key or Password',
    });
    expect(asked.map((each) => each.url)).toEqual(['/api/getAllCities/format/json/']);

    const courier = leopards();
    answers = [
      { status: 200, body: CITIES },
      { status: 200, body: { status: 0, error: 'Destination city is not serviceable' } },
      {
        status: 200,
        body: {
          status: 0,
          error: { consignment_phone: 'Consignee phone is invalid', booked_packet_weight: '' },
        },
      },
      { status: 503, body: { status: 0 } },
      { status: 429, body: {} },
      { status: 200, body: '<html>Maintenance</html>' },
      { status: 200, body: { status: 1, error: 0 } },
    ];
    const tries = [];
    for (let i = answers.length - 1; i > 0; i--)
      tries.push(await courier.book(credentials, SHIPMENT));
    expect(tries).toEqual([
      { ok: false, retry: false, message: 'Leopards: Destination city is not serviceable' },
      { ok: false, retry: false, message: 'Leopards: Consignee phone is invalid' },
      { ok: false, retry: true, message: 'Leopards: it answered 503' },
      { ok: false, retry: true, message: 'Leopards: it answered 429' },
      { ok: false, retry: true, message: 'Leopards: it answered 200' },
      { ok: false, retry: false, message: 'Leopards booked the parcel without a tracking number' },
    ]);
    const unreachable = await new LeopardsCourier({
      baseUrl: 'http://127.0.0.1:9/api',
      timeoutMs: 1_000,
    }).book(credentials, SHIPMENT);
    expect(unreachable).toMatchObject({ ok: false, retry: true });
    expect(unreachable.ok ? '' : unreachable.message).toMatch(/^Leopards could not be reached: /);
  });

  it('tracks fifty parcels a request, leaving out those it does not know', async () => {
    const numbers = Array.from(
      { length: 51 },
      (_, index) => `LE${String(index).padStart(10, '0')}`,
    );
    answers = [
      {
        status: 200,
        body: {
          status: 1,
          error: 0,
          packet_list: [
            { track_number: numbers[0], booked_packet_status: 'Assign to Courier' },
            { track_number: numbers[7], booked_packet_status: ' Arrived at Station ' },
            // Another account's, or one not asked about.
            { track_number: 'LE9999999999', booked_packet_status: 'Delivered' },
            { track_number: numbers[9], booked_packet_status: '' },
          ],
        },
      },
      {
        status: 200,
        body: {
          status: 1,
          packet_list: [
            {
              booked_packet_cn: numbers[50],
              'Tracking Detail': [{ Status: 'Consignment Booked' }, { Status: 'Dispatched' }],
            },
          ],
        },
      },
    ];
    expect(await leopards().track(credentials, numbers)).toEqual({
      ok: true,
      value: [
        { trackingNumber: numbers[0], status: 'Assign to Courier' },
        { trackingNumber: numbers[7], status: 'Arrived at Station' },
        { trackingNumber: numbers[50], status: 'Dispatched' },
      ],
    });
    expect(asked.map((each) => [each.url, each.body])).toEqual([
      [
        '/api/trackBookedPacket/format/json/',
        { ...signed, track_numbers: numbers.slice(0, 50).join(',') },
      ],
      ['/api/trackBookedPacket/format/json/', { ...signed, track_numbers: numbers[50] }],
    ]);

    // One it does not know refusing them all: each asked about alone, those refused left out.
    asked.length = 0;
    answers = [
      { status: 200, body: { status: 0, error: 'Invalid tracking number LE0000000001' } },
      {
        status: 200,
        body: {
          status: 1,
          packet_list: [{ track_number: 'LE1', booked_packet_status: 'Pending' }],
        },
      },
      { status: 200, body: { status: 0, error: 'Invalid tracking number LE0000000001' } },
      {
        status: 200,
        body: {
          status: 1,
          packet_list: [{ track_number: 'LE3', booked_packet_status: 'Delivered' }],
        },
      },
    ];
    expect(await leopards().track(credentials, ['LE1', 'LE0000000001', 'LE3'])).toEqual({
      ok: true,
      value: [
        { trackingNumber: 'LE1', status: 'Pending' },
        { trackingNumber: 'LE3', status: 'Delivered' },
      ],
    });
    expect(asked.map((each) => each.body?.track_numbers)).toEqual([
      'LE1,LE0000000001,LE3',
      'LE1',
      'LE0000000001',
      'LE3',
    ]);

    // Refusing every one is the account's doing, and Leopards down stops the round.
    answers = [
      { status: 200, body: { status: 0, error: 'Invalid API Key or Password' } },
      { status: 200, body: { status: 0, error: 'Invalid API Key or Password' } },
      { status: 200, body: { status: 0, error: 'Invalid API Key or Password' } },
    ];
    expect(await leopards().track(credentials, ['LE1', 'LE2'])).toEqual({
      ok: false,
      retry: false,
      message: 'Leopards: Invalid API Key or Password',
    });
    answers = [{ status: 502, body: {} }];
    expect(await leopards().track(credentials, ['LE1', 'LE2'])).toMatchObject({
      ok: false,
      retry: true,
    });
  });

  it('cancels a booking', async () => {
    expect(await leopards().cancel(credentials, 'LE7522377485')).toEqual({
      ok: true,
      value: null,
    });
    expect(asked).toEqual([
      {
        method: 'POST',
        url: '/api/cancelBookedPackets/format/json/',
        body: { ...signed, cn_numbers: 'LE7522377485' },
      },
    ]);
    answers = [{ status: 200, body: { status: 0, error: 'Packet already picked' } }];
    expect(await leopards().cancel(credentials, 'LE7522377485')).toEqual({
      ok: false,
      retry: false,
      message: 'Leopards: Packet already picked',
    });
  });
});

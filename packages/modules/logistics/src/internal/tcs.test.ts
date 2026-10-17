import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TcsCourier, type CourierShipment } from './couriers.js';

/** What the fake TCS was asked. */
interface Asked {
  method: string;
  url: string;
  clientId: string | undefined;
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

const OK = { status: 'SUCCESS', message: 'SUCCESS', code: '0200' };

describe('TCS (SHP-01, ADR-509)', () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  /** How the fake answers each request, in turn; SUCCESS and nothing more when none is left. */
  let answers: { status: number; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({
          method: request.method ?? '',
          url: request.url ?? '',
          clientId: request.headers['x-ibm-client-id'] as string | undefined,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        });
        const answer = answers.shift() ?? { status: 200, body: { returnStatus: OK } };
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/cod/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    asked.length = 0;
    answers = [];
  });

  const tcs = () => new TcsCourier({ baseUrl, timeoutMs: 2_000 });
  const credentials = {
    clientId: 'c1d2-77aa',
    userName: 'zari.lhr',
    password: 'Tc$-4410',
    costCenterCode: '01',
    originCity: 'Karachi',
  };
  const signed = { userName: 'zari.lhr', password: 'Tc$-4410' };

  it('books a parcel from the account’s city, its client ID in a header, and reads its CN', async () => {
    answers = [
      {
        status: 200,
        body: { returnStatus: OK, bookingReply: { result: 'Your generated CN is: 779404061230' } },
      },
    ];
    expect(await tcs().book(credentials, SHIPMENT)).toEqual({
      ok: true,
      value: { trackingNumber: '779404061230' },
    });
    expect(asked).toEqual([
      {
        method: 'POST',
        url: '/v1/cod/create-order',
        clientId: 'c1d2-77aa',
        body: {
          ...signed,
          costCenterCode: '01',
          consigneeName: 'Ayesha Khan',
          consigneeAddress: 'House 12, Street 4, Gulberg III, near Liberty Market',
          consigneeMobNo: '03001234567',
          consigneeEmail: '',
          originCityName: 'Karachi',
          destinationCityName: 'Lahore',
          weight: 0.9,
          pieces: 3,
          codAmount: '2001',
          customerReferenceNo: '#1043',
          services: 'O',
          productDetails: 'Kurta - Red x 2, Dupatta',
          fragile: 'No',
          remarks: '',
          insuranceValue: 0,
        },
      },
    ]);

    // Another cost centre where the account gives one as the pickup code; nothing to collect on
    // an order paid ahead, and a parcel without a weight its first half kilo.
    asked.length = 0;
    answers = [{ status: 200, body: { returnStatus: OK, bookingReply: { result: 'CN: 7794' } } }];
    expect(
      await tcs().book(credentials, {
        ...SHIPMENT,
        codAmount: 0n,
        weightGrams: null,
        pickupCode: ' 07 ',
      }),
    ).toEqual({ ok: false, retry: false, message: 'TCS booked the parcel without a CN' });
    expect(asked[0]!.body).toMatchObject({ costCenterCode: '07', codAmount: '0', weight: 0.5 });
  });

  it('says what TCS refused, and tries again only when it could not answer', async () => {
    answers = [
      {
        status: 200,
        body: {
          returnStatus: { status: 'FAIL', message: 'Invalid destination city', code: '0400' },
        },
      },
    ];
    expect(await tcs().book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: false,
      message: 'TCS: Invalid destination city',
    });
    answers = [{ status: 503, body: 'Service Unavailable' }];
    expect(await tcs().book(credentials, SHIPMENT)).toEqual({
      ok: false,
      retry: true,
      message: 'TCS: it answered 503',
    });
    const unreachable = new TcsCourier({ baseUrl: 'http://127.0.0.1:9/', timeoutMs: 500 });
    expect(await unreachable.book(credentials, SHIPMENT)).toMatchObject({ ok: false, retry: true });
  });

  it('tracks each parcel by its latest status, leaving out those TCS does not know', async () => {
    answers = [
      {
        status: 200,
        body: {
          returnStatus: OK,
          TrackDetailReply: {
            DeliveryInfo: [],
            Checkpoints: [
              { dateTime: '2026-10-16T09:10:00', status: 'Arrived at TCS Facility' },
              { dateTime: '2026-10-17T08:30:00', status: ' Out For Delivery ' },
              { dateTime: '2026-10-15T18:00:00', status: 'Booked' },
            ],
          },
        },
      },
      {
        status: 200,
        body: { returnStatus: { status: 'FAIL', message: 'No record found', code: '0404' } },
      },
      {
        status: 200,
        body: {
          returnStatus: OK,
          TrackDetailReply: {
            DeliveryInfo: [{ status: 'DELIVERED', dateTime: '2026-10-17T12:00:00' }],
            Checkpoints: [{ status: 'Out For Delivery' }],
          },
        },
      },
    ];
    expect(await tcs().track(credentials, ['7794001', '7794002', '7794003'])).toEqual({
      ok: true,
      value: [
        { trackingNumber: '7794001', status: 'Out For Delivery' },
        { trackingNumber: '7794003', status: 'DELIVERED' },
      ],
    });
    expect(asked.map((each) => `${each.method} ${each.url}`)).toEqual([
      'GET /v1/cod/track-order?consignmentNo=7794001',
      'GET /v1/cod/track-order?consignmentNo=7794002',
      'GET /v1/cod/track-order?consignmentNo=7794003',
    ]);

    // An account TCS refuses stops the round.
    answers = [
      { status: 401, body: { returnStatus: { status: 'FAIL', message: 'Unauthorized' } } },
    ];
    expect(await tcs().track(credentials, ['7794001', '7794002'])).toEqual({
      ok: false,
      retry: false,
      message: 'TCS: Unauthorized',
    });
  });

  it('cancels a booking, and lists the cities TCS delivers to once a day', async () => {
    expect(await tcs().cancel(credentials, '7794001')).toEqual({ ok: true, value: null });
    expect(asked[0]).toEqual({
      method: 'PUT',
      url: '/v1/cod/cancel-order',
      clientId: 'c1d2-77aa',
      body: { ...signed, consignmentNumber: '7794001' },
    });

    const courier = tcs();
    asked.length = 0;
    answers = [
      {
        status: 200,
        body: {
          returnStatus: OK,
          allCities: [
            { cityID: 1, cityName: 'LAHORE' },
            { cityID: 2, cityName: 'Dera Ghazi Khan' },
            { cityID: 3, cityName: 'lahore' },
            { cityID: 4, cityName: ' ' },
          ],
        },
      },
    ];
    expect(await courier.cities(credentials)).toEqual({
      ok: true,
      value: ['LAHORE', 'Dera Ghazi Khan'],
    });
    expect(await courier.cities(credentials)).toEqual({
      ok: true,
      value: ['LAHORE', 'Dera Ghazi Khan'],
    });
    expect(asked.map((each) => `${each.method} ${each.url}`)).toEqual(['GET /v1/cod/cities']);

    answers = [{ status: 200, body: { returnStatus: OK, allCities: [] } }];
    expect(await tcs().cities(credentials)).toEqual({
      ok: false,
      retry: true,
      message: 'TCS gave no cities to deliver to',
    });
  });
});

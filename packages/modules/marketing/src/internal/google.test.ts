import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAnalyticsClient } from './google-client.js';
import { googleClientId, googleEvent, googleEventName, googleUserData } from './google.js';
import type { ConversionOrder } from './meta.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const order: ConversionOrder = {
  number: 1043,
  currency: 'PKR',
  total: 5_250_00n,
  customerId: '01928a3b-0000-7000-8000-000000000001',
  phone: '+92 300 1234567',
  email: ' Ayesha@Example.COM ',
  name: 'Ayesha Khan',
  city: 'Rawalpindi',
  zip: null,
  clientIp: '39.40.1.2',
  clientUserAgent: 'Mozilla/5.0 (Linux; Android 14)',
  visits: [{ at: new Date('2026-10-01T08:00:00.000Z'), landingPage: '/products/kurta?gclid=Cj0' }],
  browserIds: null,
  lines: [
    { variantId: 'v-1', quantity: 2, unitPrice: 2_499_00n },
    { variantId: 'v-2', quantity: 1, unitPrice: 252_00n },
  ],
};

describe("Google Analytics' Measurement Protocol: events", () => {
  it("names the shop's chosen moment purchase, and the others by names of their own", () => {
    expect(googleEventName('placed', 'placed')).toBe('purchase');
    expect(googleEventName('confirmed', 'placed')).toBe('order_confirmed');
    expect(googleEventName('delivered', 'placed')).toBe('order_delivered');
    expect(googleEventName('placed', 'delivered')).toBe('order_placed');
    expect(googleEventName('delivered', 'delivered')).toBe('purchase');
  });

  it("makes an order's moment a request of its own, the customer's details hashed as Google normalises them", () => {
    const occurredAt = new Date('2026-10-02T09:30:00.000Z');
    expect(
      googleEvent(order, { moment: 'confirmed', occurredAt }, { purchaseAt: 'confirmed' }),
    ).toEqual({
      // One customer's orders read as one visitor's.
      client_id: sha256(order.customerId).slice(0, 32),
      user_id: sha256(order.customerId),
      timestamp_micros: occurredAt.getTime() * 1000,
      user_data: {
        // In E.164, its plus kept.
        sha256_phone_number: [sha256('+923001234567')],
        sha256_email_address: [sha256('ayesha@example.com')],
      },
      events: [
        {
          name: 'purchase',
          params: {
            transaction_id: '1043',
            currency: 'PKR',
            value: 5_250,
            items: [
              { item_id: 'v-1', quantity: 2, price: 2_499 },
              { item_id: 'v-2', quantity: 1, price: 252 },
            ],
          },
        },
      ],
    });
    expect(googleClientId(order)).toHaveLength(32);
    // Without a number or an email, no user data goes.
    expect(googleUserData({ ...order, phone: null, email: null })).toBeNull();
    expect(
      googleEvent(
        { ...order, phone: null, email: '' },
        { moment: 'placed', occurredAt },
        {
          purchaseAt: 'confirmed',
        },
      ),
    ).not.toHaveProperty('user_data');
  });
});

describe("Google Analytics' Measurement Protocol: the client", () => {
  let server: Server;
  let baseUrl: string;
  const asked: { url: string; body: unknown }[] = [];
  let answers: { status: number; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({ url: request.url!, body: JSON.parse(text) });
        const answer = answers.shift() ?? { status: 204, body: '' };
        response.writeHead(answer.status);
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    asked.length = 0;
    answers = [];
  });

  const stream = { measurementId: 'G-AB12CD34EF', apiSecret: 'Xy9_kq2Lm&N0' };
  const payload = (n: number) =>
    googleEvent(
      { ...order, number: n },
      { moment: 'placed', occurredAt: new Date() },
      {
        purchaseAt: 'placed',
      },
    );

  it('sends each payload in a request of its own, the stream and secret in the address', async () => {
    const client = new GoogleAnalyticsClient({ baseUrl: `${baseUrl}/` });
    expect(await client.send(stream, [payload(1), payload(2)])).toEqual({ ok: true });
    expect(asked.map((each) => each.url)).toEqual([
      '/mp/collect?measurement_id=G-AB12CD34EF&api_secret=Xy9_kq2Lm%26N0',
      '/mp/collect?measurement_id=G-AB12CD34EF&api_secret=Xy9_kq2Lm%26N0',
    ]);
    expect(
      asked.map(
        (each) =>
          (each.body as { events: { params: { transaction_id: string } }[] }).events[0]!.params
            .transaction_id,
      ),
    ).toEqual(['1', '2']);
  });

  it('stops at the first Google refuses, trying again only what Google could not take yet', async () => {
    const client = new GoogleAnalyticsClient({ baseUrl });
    answers = [
      { status: 204, body: '' },
      { status: 503, body: 'Service Unavailable' },
    ];
    expect(await client.send(stream, [payload(1), payload(2), payload(3)])).toEqual({
      ok: false,
      retry: true,
      message: 'Google 503: Service Unavailable',
    });
    expect(asked).toHaveLength(2);
    answers = [{ status: 429, body: '' }];
    expect(await client.send(stream, [payload(1)])).toEqual({
      ok: false,
      retry: true,
      message: 'Google 429: no answer',
    });
    answers = [{ status: 400, body: 'Bad Request' }];
    expect(await client.send(stream, [payload(1)])).toEqual({
      ok: false,
      retry: false,
      message: 'Google 400: Bad Request',
    });
    const unreachable = new GoogleAnalyticsClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(await unreachable.send(stream, [payload(1)])).toMatchObject({
      ok: false,
      retry: true,
      message: expect.stringMatching(/^Google could not be reached: /) as string,
    });
  });
});

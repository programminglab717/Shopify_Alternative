import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversionOrder } from './meta.js';
import { TikTokEventsClient } from './tiktok-client.js';
import { tiktokClickOf, tiktokEvent, tiktokEventName, tiktokUser } from './tiktok.js';

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
  visits: [
    { at: new Date('2026-10-01T08:00:00.000Z'), landingPage: '/collections/lawn?utm_source=ig' },
    {
      at: new Date('2026-09-30T10:00:00.000Z'),
      landingPage: '/products/kurta?ttclid=E.C.P.CjwBhz-1&utm_source=tiktok#reviews',
    },
  ],
  browserIds: null,
  lines: [
    { variantId: 'v-1', quantity: 2, unitPrice: 2_499_00n },
    { variantId: 'v-2', quantity: 1, unitPrice: 252_00n },
  ],
};

describe("TikTok's Events API: events", () => {
  it("names the shop's chosen moment CompletePayment, and the others by TikTok's names or their own", () => {
    expect(tiktokEventName('placed', 'placed')).toBe('CompletePayment');
    expect(tiktokEventName('confirmed', 'placed')).toBe('OrderConfirmed');
    expect(tiktokEventName('delivered', 'placed')).toBe('OrderDelivered');
    expect(tiktokEventName('placed', 'delivered')).toBe('PlaceAnOrder');
    expect(tiktokEventName('delivered', 'delivered')).toBe('CompletePayment');
  });

  it("hashes the customer's details as TikTok normalises them, the browser's and the ad's click as they are", () => {
    expect(tiktokUser(order)).toEqual({
      external_id: sha256(order.customerId),
      // In E.164, its plus kept.
      phone: sha256('+923001234567'),
      email: sha256('ayesha@example.com'),
      ip: '39.40.1.2',
      user_agent: 'Mozilla/5.0 (Linux; Android 14)',
      ttclid: 'E.C.P.CjwBhz-1',
    });
    // Without them, nothing of them goes.
    expect(
      tiktokUser({
        ...order,
        phone: null,
        email: '  ',
        clientIp: null,
        clientUserAgent: null,
        visits: [],
      }),
    ).toEqual({ external_id: sha256(order.customerId) });
  });

  it("finds TikTok's click from the latest visit whose address had one", () => {
    expect(tiktokClickOf(order.visits)).toBe('E.C.P.CjwBhz-1');
    expect(
      tiktokClickOf([
        { at: new Date(), landingPage: '/?ttclid=latest' },
        { at: new Date(), landingPage: '/?ttclid=older' },
      ]),
    ).toBe('latest');
    expect(tiktokClickOf([{ at: new Date(), landingPage: '/?fbclid=meta' }])).toBeNull();
    expect(tiktokClickOf([{ at: new Date(), landingPage: null }])).toBeNull();
  });

  it("makes a web event of an order's moment, the same ID however often it goes", () => {
    const occurredAt = new Date('2026-10-02T09:30:15.500Z');
    const event = tiktokEvent(
      order,
      { moment: 'confirmed', occurredAt },
      { purchaseAt: 'confirmed', sourceUrl: 'https://zari.pk/checkout' },
    );
    expect(event).toEqual({
      event: 'CompletePayment',
      event_time: Math.floor(occurredAt.getTime() / 1000),
      event_id: 'order-1043-confirmed',
      user: tiktokUser(order),
      properties: {
        currency: 'PKR',
        value: 5_250,
        order_id: '1043',
        content_type: 'product',
        contents: [
          { content_id: 'v-1', quantity: 2, price: 2_499 },
          { content_id: 'v-2', quantity: 1, price: 252 },
        ],
      },
      page: { url: 'https://zari.pk/checkout' },
    });
    expect(
      tiktokEvent(
        order,
        { moment: 'confirmed', occurredAt: new Date() },
        { purchaseAt: 'confirmed', sourceUrl: 'https://zari.pk/checkout' },
      ).event_id,
    ).toBe(event.event_id);
  });
});

describe("TikTok's Events API: the client", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  let answer: { status: number; body: string } = { status: 200, body: '{}' };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        requests.push({
          url: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(text) as unknown,
        });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const pixel = { pixelCode: 'CABC123DEF456GHI789J', accessToken: 'tok-123', testEventCode: null };
  const event = tiktokEvent(
    order,
    { moment: 'placed', occurredAt: new Date('2026-10-02T09:30:00.000Z') },
    { purchaseAt: 'placed', sourceUrl: 'https://zari.pk/checkout' },
  );

  it('sends the events to the pixel, its token in a header, and reads what TikTok said', async () => {
    answer = { status: 200, body: '{"code":0,"message":"OK","request_id":"req-1"}' };
    const client = new TikTokEventsClient({ baseUrl });
    expect(await client.send(pixel, [event])).toEqual({ ok: true, requestId: 'req-1' });
    const [request] = requests.splice(0);
    expect(request!.url).toBe('/open_api/v1.3/event/track/');
    expect(request!.headers['access-token']).toBe('tok-123');
    expect(request!.body).toEqual({
      event_source: 'web',
      event_source_id: 'CABC123DEF456GHI789J',
      data: [event],
    });
    // With the shop's code for test events.
    await client.send({ ...pixel, testEventCode: 'TEST31337' }, [event]);
    expect(requests.splice(0)[0]!.body).toMatchObject({ test_event_code: 'TEST31337' });
  });

  it('tries again when TikTok is over its limits or in trouble, or the token is wrong, and not when the events are', async () => {
    const client = new TikTokEventsClient({ baseUrl });
    const said = async (status: number, body: string) => {
      answer = { status, body };
      return client.send(pixel, [event]);
    };
    expect(
      await said(200, '{"code":40100,"message":"Too many requests","request_id":"r"}'),
    ).toEqual({
      ok: false,
      retry: true,
      message: 'TikTok 40100: Too many requests',
      requestId: 'r',
    });
    expect(await said(200, '{"code":40105,"message":"Access token is invalid"}')).toMatchObject({
      ok: false,
      retry: true,
    });
    expect(await said(200, '{"code":40002,"message":"Invalid event_source_id"}')).toEqual({
      ok: false,
      retry: false,
      message: 'TikTok 40002: Invalid event_source_id',
      requestId: null,
    });
    expect(await said(503, 'Service Unavailable')).toEqual({
      ok: false,
      retry: true,
      message: 'TikTok 503: no answer',
      requestId: null,
    });
    expect(await said(429, '{}')).toMatchObject({ ok: false, retry: true });
    requests.splice(0);
  });

  it('tries again when TikTok cannot be reached', async () => {
    const client = new TikTokEventsClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(await client.send(pixel, [event])).toMatchObject({
      ok: false,
      retry: true,
      requestId: null,
    });
  });
});

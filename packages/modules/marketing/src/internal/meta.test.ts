import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetaConversionsClient } from './meta-client.js';
import {
  META_EVENT_WINDOW_MS,
  clickOf,
  metaEvent,
  metaEventName,
  metaUserData,
  retryDelayMs,
  type ConversionOrder,
} from './meta.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const CLICKED = new Date('2026-09-30T10:00:00.000Z');

const order: ConversionOrder = {
  number: 1043,
  currency: 'PKR',
  total: 5_250_00n,
  customerId: '01928a3b-0000-7000-8000-000000000001',
  phone: '+923001234567',
  email: ' Ayesha@Example.COM ',
  name: 'Ayesha  Khan',
  city: 'Rawalpindi',
  zip: null,
  clientIp: '39.40.1.2',
  clientUserAgent: 'Mozilla/5.0 (Linux; Android 14)',
  visits: [
    { at: new Date('2026-10-01T08:00:00.000Z'), landingPage: '/collections/lawn?utm_source=ig' },
    { at: CLICKED, landingPage: '/products/kurta?fbclid=IwAR2xYz_Ab-C#reviews' },
  ],
  browserIds: null,
  lines: [
    { variantId: 'v-1', quantity: 2, unitPrice: 2_499_00n },
    { variantId: 'v-2', quantity: 1, unitPrice: 252_00n },
    { variantId: 'v-1', quantity: 1, unitPrice: 0n },
  ],
};

describe("Meta's conversions API: events", () => {
  it("names the shop's chosen moment Purchase, and the others by their own names", () => {
    expect(metaEventName('placed', 'placed')).toBe('Purchase');
    expect(metaEventName('confirmed', 'placed')).toBe('OrderConfirmed');
    expect(metaEventName('delivered', 'placed')).toBe('OrderDelivered');
    expect(metaEventName('placed', 'delivered')).toBe('OrderPlaced');
    expect(metaEventName('delivered', 'delivered')).toBe('Purchase');
  });

  it("hashes the customer's details as Meta normalises them, and keeps the browser's as they are", () => {
    expect(metaUserData(order)).toEqual({
      // The number's digits, its country's code first.
      ph: ['9f545b34641264848f0653da69036bdc0d81c22fe7cebfe39cc1efa32579a5f4'],
      em: ['2aa40bf350dd3a73b865fe561cba33cfb765856c447d86dd9e2952b2a45cf8b3'],
      fn: ['cb227008585baf4336bd323256d81e5e487b29914511090277ef4c98e3c9af8f'],
      ln: ['1ef393f2c0772064cae9403f23e7f8fc6d49bb2939f463f23c4e637231e84da4'],
      ct: ['83525b1cea2974db47a5d7382aa946892df54c1c9ea46d44c5e4af47da6d06e6'],
      country: ['eb3102a6cb586765d01fad324523ec0bc67b9efd6a2d9589c135adfedf7922cc'],
      external_id: [sha256(order.customerId)],
      client_ip_address: '39.40.1.2',
      client_user_agent: 'Mozilla/5.0 (Linux; Android 14)',
      // From the visit whose address had an ad's click, its ID as it was.
      fbc: `fb.1.${CLICKED.getTime()}.IwAR2xYz_Ab-C`,
    });
    // Names and cities lose their punctuation and spaces; Urdu letters stay.
    const city = String.fromCharCode(0x644, 0x627, 0x6c1, 0x648, 0x631);
    expect(
      metaUserData({
        ...order,
        name: "Muhammad Ali O'Brien",
        city: 'Dera Ghazi Khan',
        zip: ' 46-000 ',
      }),
    ).toMatchObject({
      fn: [sha256('muhammad')],
      ln: [sha256('obrien')],
      ct: [sha256('deraghazikhan')],
      zp: [sha256('46000')],
    });
    expect(metaUserData({ ...order, city }).ct).toEqual([sha256(city)]);
  });

  it("leaves out what an erased customer's order no longer has", () => {
    const erased = {
      ...order,
      phone: null,
      email: null,
      name: null,
      city: 'Lahore',
      clientIp: null,
      clientUserAgent: null,
      visits: [],
    };
    expect(metaUserData(erased)).toEqual({
      ct: [sha256('lahore')],
      country: [sha256('pk')],
      external_id: [sha256(order.customerId)],
    });
    // One name is a first name alone.
    expect(Object.keys(metaUserData({ ...erased, name: 'Ayesha' }))).toContain('fn');
    expect(Object.keys(metaUserData({ ...erased, name: 'Ayesha' }))).not.toContain('ln');
  });

  it("names the browser as the shop's pixel did, and the later click of its cookie's and the visits'", () => {
    const fbp = 'fb.1.1727856000000.1116446470';
    const earlier = `fb.1.${CLICKED.getTime() - 60_000}.IwEarlier`;
    const later = `fb.1.${CLICKED.getTime() + 60_000}.IwLater`;
    // The pixel's cookie kept an earlier click than a visit's, as when the pixel was blocked.
    expect(metaUserData({ ...order, browserIds: { fbp, fbc: earlier } })).toMatchObject({
      fbp,
      fbc: `fb.1.${CLICKED.getTime()}.IwAR2xYz_Ab-C`,
    });
    expect(metaUserData({ ...order, browserIds: { fbc: later } }).fbc).toBe(later);
    // Without a visit's click, the cookie's; without either, none.
    const alone = metaUserData({ ...order, visits: [], browserIds: { fbc: earlier } });
    expect([alone.fbc, alone.fbp]).toEqual([earlier, undefined]);
    expect(metaUserData({ ...order, visits: [], browserIds: { fbp } })).toMatchObject({ fbp });
    expect(Object.keys(metaUserData({ ...order, visits: [] }))).not.toContain('fbc');
  });

  it("takes an ad's click from the latest visit that had one", () => {
    expect(clickOf([])).toBeNull();
    expect(clickOf([{ at: CLICKED, landingPage: null }])).toBeNull();
    const later = new Date('2026-10-01T09:00:00.000Z');
    expect(
      clickOf([
        { at: later, landingPage: '/?fbclid=LATER' },
        { at: CLICKED, landingPage: '/?fbclid=FIRST' },
      ]),
    ).toBe(`fb.1.${later.getTime()}.LATER`);
    expect(clickOf([{ at: CLICKED, landingPage: '/products/x?gclid=abc' }])).toBeNull();
  });

  it('makes a server event of an order, its items by variant, in rupees', () => {
    const occurredAt = new Date('2026-10-02T06:30:15.900Z');
    const event = metaEvent(
      order,
      { moment: 'delivered', occurredAt },
      { purchaseAt: 'delivered', sourceUrl: 'https://www.zari.pk/checkout' },
    );
    expect(event).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(occurredAt.getTime() / 1000),
      event_id: 'order-1043-delivered',
      event_source_url: 'https://www.zari.pk/checkout',
      action_source: 'website',
      user_data: metaUserData(order),
      custom_data: {
        currency: 'PKR',
        value: 5250,
        order_id: '1043',
        content_type: 'product',
        content_ids: ['v-1', 'v-2'],
        contents: [
          { id: 'v-1', quantity: 2, item_price: 2499 },
          { id: 'v-2', quantity: 1, item_price: 252 },
          { id: 'v-1', quantity: 1, item_price: 0 },
        ],
        num_items: 4,
      },
    });
  });

  it('tries again a minute after the first try, doubling to six hours, within seven days', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(10)).toBe(6 * 60 * 60_000);
    expect(retryDelayMs(40)).toBe(6 * 60 * 60_000);
    expect(META_EVENT_WINDOW_MS).toBe((7 * 24 - 1) * 60 * 60_000);
  });
});

describe("Meta's conversions API: requests", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url: string; body: URLSearchParams }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };

  const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => resolve(text));
    });

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      requests.push({ url: request.url ?? '', body: new URLSearchParams(await read(request)) });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const dataset = {
    pixelId: '1234567890',
    accessToken: 'EAAG'.padEnd(40, 'x'),
    testEventCode: null,
  };
  const event = metaEvent(
    order,
    { moment: 'placed', occurredAt: new Date() },
    { purchaseAt: 'placed', sourceUrl: 'https://www.zari.pk/checkout' },
  );

  it("posts the events to the dataset, the token in the request's body", async () => {
    const client = new MetaConversionsClient({ baseUrl: `${baseUrl}/`, version: 'v26.0' });
    answer = { status: 200, body: { events_received: 1, messages: [], fbtrace_id: 'AbC123' } };
    expect(await client.send({ ...dataset, testEventCode: 'TEST4242' }, [event])).toEqual({
      ok: true,
      eventsReceived: 1,
      traceId: 'AbC123',
    });
    const [sent] = requests.splice(0);
    expect(sent!.url).toBe('/v26.0/1234567890/events');
    expect(JSON.parse(sent!.body.get('data')!)).toEqual([event]);
    expect(sent!.body.get('access_token')).toBe(dataset.accessToken);
    expect(sent!.body.get('test_event_code')).toBe('TEST4242');
    await client.send(dataset, [event]);
    expect(requests.splice(0)[0]!.body.has('test_event_code')).toBe(false);
  });

  it('tries again when Meta is busy or the token is wrong, and not when an event is', async () => {
    const client = new MetaConversionsClient({ baseUrl, version: 'v26.0' });
    const refused = (status: number, error: Record<string, unknown>) => {
      answer = { status, body: { error: { fbtrace_id: 'T1', ...error } } };
      return client.send(dataset, [event]);
    };
    expect(await refused(400, { code: 190, message: 'Error validating access token' })).toEqual({
      ok: false,
      retry: true,
      message: 'Error validating access token',
      traceId: 'T1',
    });
    expect(await refused(403, { code: 200, message: 'Permissions error' })).toMatchObject({
      retry: true,
    });
    expect(await refused(400, { code: 17, message: 'User request limit reached' })).toMatchObject({
      retry: true,
    });
    expect(await refused(500, { code: 2, message: 'Service unavailable' })).toMatchObject({
      retry: true,
    });
    expect(
      await refused(400, {
        code: 100,
        message: 'Invalid parameter',
        error_user_msg: 'The event time is too far in the past.',
      }),
    ).toEqual({
      ok: false,
      retry: false,
      message: 'The event time is too far in the past.',
      traceId: 'T1',
    });
    expect(await refused(400, { code: 100, is_transient: true })).toMatchObject({ retry: true });
    requests.splice(0);

    // Nothing answering at all is tried again too.
    const nowhere = new MetaConversionsClient({
      baseUrl: 'http://127.0.0.1:1',
      version: 'v26.0',
      timeoutMs: 2_000,
    });
    expect(await nowhere.send(dataset, [event])).toMatchObject({ ok: false, retry: true });
  });
});

import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { createLogger } from '@hatti/logger';
import {
  ConversionsService,
  GoogleAnalyticsClient,
  GoogleAnalyticsService,
  MetaConversionsClient,
  MetaConversionsService,
  TikTokEventsClient,
  TikTokEventsService,
  type GoogleEventsPayload,
  type MetaServerEvent,
  type TikTokEvent,
} from '@hatti/marketing/public';
import {
  BankTransferService,
  FulfillmentService,
  OrderEditService,
  type AttributionValue,
  type OrderToPlace,
} from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversionMoments, ConversionsSender, workerConversionOrders } from './conversions.js';
import { eventHandlers } from './start-worker.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Wx9z';
const CLICKED = new Date('2026-09-30T10:00:00.000Z');

describe.skipIf(!server)("Orders sent to Meta's conversions API", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let graph: Server;
  let graphUrl: string;
  /** What the fake Graph API was sent, and what it answers next. */
  const requests: { url: string; events: MetaServerEvent[]; body: URLSearchParams }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  /** What the fake TikTok API was sent, and what it answers next. */
  const tiktokRequests: {
    url: string;
    token: string | undefined;
    body: {
      event_source: string;
      event_source_id: string;
      test_event_code?: string;
      data: TikTokEvent[];
    };
  }[] = [];
  let tiktokAnswer: { status: number; body: unknown } = { status: 200, body: {} };
  /** What the fake Google Analytics was sent, and what it answers next. */
  const googleRequests: { url: string; body: GoogleEventsPayload }[] = [];
  let googleAnswer: { status: number; body: string } = { status: 204, body: '' };
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_pixels']),
  };
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  let variantId: string;
  let otherVariantId: string;

  const meta = () => new MetaConversionsService(database, box);
  const tiktok = () => new TikTokEventsService(database, box);
  const google = () => new GoogleAnalyticsService(database, box);
  const moments = () => new ConversionsService(database);
  const orders = () => workerOrders(database);
  const sender = () =>
    new ConversionsSender({
      database,
      conversions: moments(),
      meta: meta(),
      orders: workerConversionOrders(database),
      client: new MetaConversionsClient({ baseUrl: graphUrl, version: 'v26.0' }),
      tiktok: tiktok(),
      tiktokClient: new TikTokEventsClient({ baseUrl: graphUrl }),
      google: google(),
      googleClient: new GoogleAnalyticsClient({ baseUrl: graphUrl }),
      storefronts: new StorefrontSite('http://localhost:4100'),
    });
  const handlers = () =>
    eventHandlers(createLogger({ name: 'worker', level: 'silent' }), {
      conversions: new ConversionMoments(moments(), workerConversionOrders(database)),
    });

  /** The events recorded since the last call, oldest first, handed to the worker's handlers. */
  const dispatch = async (): Promise<string[]> => {
    const { rows } = await admin.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(`
      UPDATE platform.outbox_events SET published_at = now()
       WHERE published_at IS NULL
      RETURNING id, aggregate_type, aggregate_id, event_type, payload, occurred_at`);
    const events: DomainEvent[] = rows
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || (a.id < b.id ? -1 : 1))
      .map((row) => ({
        id: row.id,
        type: row.event_type,
        shopId,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
      }));
    const registry = handlers();
    for (const event of events) await registry.dispatch(event);
    return events.map((event) => event.type);
  };

  const recorded = async () =>
    (
      await admin.query<{
        order_id: string;
        moment: string;
        status: string;
        event_name: string | null;
        error: string | null;
      }>(
        `SELECT order_id, moment, status, event_name, error FROM marketing.conversions
          WHERE shop_id = $1 ORDER BY occurred_at, moment`,
        [shopId],
      )
    ).rows.map((row) => [row.order_id, row.moment, row.status, row.event_name, row.error]);

  /** How sending an order's moment went, and what was said of it. */
  const statusOf = async (orderId: string, moment = 'placed') =>
    (await recorded())
      .filter(([id, at]) => id === orderId && at === moment)
      .map(([, , status, , error]) => [status, error])[0];

  const visits: AttributionValue = {
    first: {
      at: CLICKED.toISOString(),
      source: 'facebook',
      utm: null,
      landingPage: '/products/kurta?fbclid=IwAR2xYz_Ab-C',
    },
    last: {
      at: '2026-10-01T08:00:00.000Z',
      source: 'instagram',
      utm: { source: 'ig', medium: null, campaign: 'eid', term: null, content: null },
      landingPage: '/collections/lawn?utm_source=ig&utm_campaign=eid',
    },
  };

  /** Places an order as checkout does, from the online store, or as staff do from a chat. */
  const placeOnline = async (
    overrides: Partial<OrderToPlace> = {},
    source: 'online_store' | 'whatsapp' = 'online_store',
  ) => {
    const service = orders();
    return unwrap(
      await database.tenant(shopId, (tx) =>
        service.placeIn(
          tx,
          {
            shopId,
            currency: 'PKR',
            actor: 'system',
            source,
            how: source === 'online_store' ? 'from the online store' : 'from WhatsApp',
          },
          {
            field: [],
            lines: [
              { variantId, quantity: 2, price: null },
              { variantId: otherVariantId, quantity: 1, price: null },
            ],
            address: {
              name: 'Ayesha Khan',
              phone: '+923001112223',
              address1: 'House 12, Street 4',
              address2: null,
              landmark: null,
              city: 'Rawalpindi',
              provinceCode: null,
              zip: null,
              location: null,
            },
            email: 'Ayesha@Example.com',
            paymentMethod: 'cash_on_delivery',
            shipping: 250_00n,
            discount: 0n,
            advance: 0n,
            locationId: null,
            note: '',
            tags: [],
            agreement: {
              policyVersions: [],
              ip: '39.40.1.2',
              userAgent: 'Mozilla/5.0 (Linux; Android 14)',
            },
            attribution: visits,
            ...overrides,
          },
        ),
      ),
    );
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'conversions-test',
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
    const other = unwrap(
      await new ProductService(database).create(tenant, {
        title: 'Dupatta',
        status: 'active',
        variants: [{ price: '750' }],
      }),
    );
    variantId = product.variants[0]!.id;
    otherVariantId = other.variants[0]!.id;
    const location = await new LocationService(database).primary(tenant);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
        name: 'on_hand',
        reason: 'received',
        quantities: [
          { inventoryItemId: variantId, locationId: location.id, quantity: 100 },
          { inventoryItemId: otherVariantId, locationId: location.id, quantity: 100 },
        ],
      }),
    );

    graph = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        if (request.url?.startsWith('/mp/collect')) {
          googleRequests.push({
            url: request.url,
            body: JSON.parse(text) as GoogleEventsPayload,
          });
          response.writeHead(googleAnswer.status);
          response.end(googleAnswer.body);
          return;
        }
        if (request.url?.startsWith('/open_api/')) {
          tiktokRequests.push({
            url: request.url,
            token: request.headers['access-token'] as string | undefined,
            body: JSON.parse(text) as (typeof tiktokRequests)[number]['body'],
          });
          response.writeHead(tiktokAnswer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(tiktokAnswer.body));
          return;
        }
        const body = new URLSearchParams(text);
        requests.push({
          url: request.url ?? '',
          events: JSON.parse(body.get('data') ?? '[]') as MetaServerEvent[],
          body,
        });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
    graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => graph?.close(() => resolve()));
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    requests.splice(0);
    tiktokRequests.splice(0);
    googleRequests.splice(0);
    googleAnswer = { status: 204, body: '' };
    answer = { status: 200, body: { events_received: 1, fbtrace_id: 'AbC123' } };
    tiktokAnswer = { status: 200, body: { code: 0, message: 'OK', request_id: 'req-1' } };
    await admin.query(
      'DELETE FROM marketing.meta_settings; DELETE FROM marketing.tiktok_settings; ' +
        'DELETE FROM marketing.google_settings; DELETE FROM marketing.conversions',
    );
    await dispatch();
  });

  it('sends an order from checkout as it is placed, confirmed and delivered, once each', async () => {
    unwrap(
      await meta().update(tenant, {
        pixelId: '1234567890',
        accessToken: TOKEN,
        testEventCode: 'TEST4242',
      }),
    );
    // From a browser the shop's pixel named, its click on an ad kept since the visit's.
    const order = await placeOnline({
      browserIds: { fbp: 'fb.1.1727856000000.1116446470', fbc: 'fb.1.1727000000000.IwOlder' },
    });
    // Staff's orders are not checkout's: no ad brought them.
    const manual = unwrap(
      await orders().create(tenant, {
        lineItems: [{ variantId, quantity: 1 }],
        shippingAddress: {
          name: 'Bilal',
          phone: '0300 5556667',
          address1: 'Shop 3',
          city: 'Lahore',
        },
      }),
    );
    const placedEvents = await dispatch();
    expect(placedEvents.filter((type) => type.startsWith('order.'))).toEqual([
      'order.created',
      'order.created',
    ]);
    expect(await recorded()).toEqual([[order.id, 'placed', 'pending', null, null]]);

    expect(await sender().sweep()).toBe(1);
    const [request] = requests.splice(0);
    expect(request!.url).toBe('/v26.0/1234567890/events');
    expect(request!.body.get('access_token')).toBe(TOKEN);
    expect(request!.body.get('test_event_code')).toBe('TEST4242');
    const [placed] = request!.events;
    expect(placed).toEqual({
      event_name: 'Purchase',
      event_time: expect.any(Number) as number,
      event_id: `order-${order.number}-placed`,
      event_source_url: 'http://zari.localhost:4100/checkout',
      action_source: 'website',
      user_data: {
        ph: [sha256('923001112223')],
        em: [sha256('ayesha@example.com')],
        fn: [sha256('ayesha')],
        ln: [sha256('khan')],
        ct: [sha256('rawalpindi')],
        country: [sha256('pk')],
        external_id: [sha256(order.customerId)],
        client_ip_address: '39.40.1.2',
        client_user_agent: 'Mozilla/5.0 (Linux; Android 14)',
        // The ad's click from the first visit, the last having none, and later than the pixel's.
        fbc: `fb.1.${CLICKED.getTime()}.IwAR2xYz_Ab-C`,
        fbp: 'fb.1.1727856000000.1116446470',
      },
      custom_data: {
        currency: 'PKR',
        // Its items and its delivery charge.
        value: 5_000,
        order_id: String(order.number),
        content_type: 'product',
        content_ids: [variantId, otherVariantId],
        contents: [
          { id: variantId, quantity: 2, item_price: 2_000 },
          { id: otherVariantId, quantity: 1, item_price: 750 },
        ],
        num_items: 3,
      },
    });
    // When its event says the order was placed, written a moment after the order: its second may
    // be the next one.
    const { rows: moments } = await admin.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM marketing.conversions WHERE order_id = $1 AND moment = 'placed'`,
      [order.id],
    );
    expect(placed!.event_time).toBe(Math.floor(moments[0]!.occurred_at.getTime() / 1000));
    expect(placed!.event_time - Math.floor(order.createdAt.getTime() / 1000)).toBeLessThanOrEqual(
      1,
    );
    expect(await recorded()).toEqual([[order.id, 'placed', 'sent', 'Purchase', null]]);
    // Nothing more is due.
    expect(await sender().sweep()).toBe(0);
    expect(requests).toEqual([]);

    // Confirmed, shipped and delivered: two moments more, the same event handled twice as one.
    unwrap(await orders().confirm(tenant, order.id));
    const fulfillments = new FulfillmentService(database, new StockService());
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(tenant, order.id, {}));
    unwrap(await fulfillments.markDelivered(tenant, fulfillmentId));
    unwrap(await orders().confirm(tenant, manual.id));
    await dispatch();
    expect(await sender().sweep()).toBe(2);
    expect(
      requests.splice(0)[0]!.events.map((event) => [event.event_name, event.event_id]),
    ).toEqual([
      ['OrderConfirmed', `order-${order.number}-confirmed`],
      ['OrderDelivered', `order-${order.number}-delivered`],
    ]);
    expect((await recorded()).map(([, moment, status]) => [moment, status])).toEqual([
      ['placed', 'sent'],
      ['confirmed', 'sent'],
      ['delivered', 'sent'],
    ]);
  });

  it("counts the shop's chosen moment as Purchase, a paid-ahead order's payment as its confirming, and a split part as placed once", async () => {
    unwrap(
      await meta().update(tenant, {
        pixelId: '1234567890',
        accessToken: TOKEN,
        purchaseAt: 'delivered',
      }),
    );
    // Paid ahead: its money coming in confirms it.
    unwrap(
      await new BankTransferService(database).update(tenant, {
        enabled: true,
        account: {
          title: 'Zari Fashions',
          bankName: 'Meezan Bank',
          iban: 'PK36SCBL0000001123456702',
        },
      }),
    );
    const prepaid = await placeOnline({ paymentMethod: 'bank_transfer' });
    // Cash on delivery, split before packing: its part was placed as the order.
    const split = await placeOnline();
    await dispatch();
    await sender().sweep();
    expect(
      requests.splice(0)[0]!.events.map((event) => [event.event_name, event.custom_data.value]),
    ).toEqual([
      ['OrderPlaced', 5_000],
      ['OrderPlaced', 5_000],
    ]);
    unwrap(await orders().markAsPaid(tenant, prepaid.id));
    unwrap(await orders().confirm(tenant, split.id));
    const edits = new OrderEditService(
      database,
      new VariantService(database),
      new LocationService(database),
      new StockService(),
    );
    const { split: part } = unwrap(
      await edits.split(tenant, split.id, {
        lineItems: [{ lineItemId: split.lines[1]!.id, quantity: 1 }],
      }),
    );
    await dispatch();
    expect((await recorded()).map(([id, moment]) => [id, moment])).toEqual([
      [prepaid.id, 'placed'],
      [split.id, 'placed'],
      [prepaid.id, 'confirmed'],
      [split.id, 'confirmed'],
    ]);
    expect((await recorded()).some(([id]) => id === part.id)).toBe(false);

    await sender().sweep();
    expect(
      requests.splice(0)[0]!.events.map((event) => [event.event_name, event.custom_data.value]),
    ).toEqual([
      ['OrderConfirmed', 5_000],
      // As it is when sent: the part sent apart taken out.
      ['OrderConfirmed', 4_250],
    ]);
    const fulfillments = new FulfillmentService(database, new StockService());
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(tenant, split.id, {}));
    unwrap(await fulfillments.markDelivered(tenant, fulfillmentId));
    await dispatch();
    await sender().sweep();
    expect(
      requests.splice(0)[0]!.events.map((event) => [event.event_name, event.custom_data.value]),
    ).toEqual([['Purchase', 4_250]]);
  });

  it('tries again while Meta cannot take them, gives up on what it refuses or what is too old, and skips erased customers and shoppers who declined', async () => {
    unwrap(await meta().update(tenant, { pixelId: '1234567890', accessToken: TOKEN }));
    const first = await placeOnline();
    await dispatch();
    const now = new Date();

    // A token Meta no longer takes: the shop can put it right, so it waits.
    answer = { status: 400, body: { error: { code: 190, message: 'Session has expired' } } };
    expect(await sender().send(shopId, now)).toBe(0);
    expect(await recorded()).toEqual([
      [first.id, 'placed', 'pending', null, 'Session has expired'],
    ]);
    expect(await sender().send(shopId, new Date(now.getTime() + 30_000))).toBe(0);
    expect(requests.splice(0)).toHaveLength(1);
    // Tried again a minute on, and refused for good.
    answer = { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } };
    await sender().send(shopId, new Date(now.getTime() + 61_000));
    expect(await recorded()).toEqual([
      [first.id, 'placed', 'failed', 'Purchase', 'Invalid parameter'],
    ]);
    requests.splice(0);

    // Older than Meta takes by the time it could go; and an erased customer's.
    answer = { status: 200, body: { events_received: 1 } };
    const old = await placeOnline();
    const erased = await placeOnline();
    const declined = await placeOnline();
    await dispatch();
    // The shop asked first, and this shopper did not accept (ADR-551).
    await admin.query(
      `UPDATE orders.orders SET browser_ids = '{"consent": "denied"}' WHERE id = $1`,
      [declined.id],
    );
    await admin.query(
      `UPDATE marketing.conversions SET occurred_at = now() - interval '7 days' WHERE order_id = $1`,
      [old.id],
    );
    await admin.query(
      `UPDATE orders.orders SET customer_erased_at = now(), phone = NULL, email = NULL,
              client_ip = NULL, client_user_agent = NULL
        WHERE id = $1`,
      [erased.id],
    );
    expect(await sender().sweep()).toBe(0);
    expect(requests).toEqual([]);
    expect(await statusOf(old.id)).toEqual([
      'expired',
      'Not sent: Meta takes events up to seven days after they happened',
    ]);
    expect(await statusOf(erased.id)).toEqual([
      'skipped',
      "Not sent: the customer's data was erased",
    ]);
    expect(await statusOf(declined.id)).toEqual([
      'skipped',
      "Not sent: the shopper declined the shop's ad cookies",
    ]);

    // Disconnected with a moment waiting: it is not sent.
    const last = await placeOnline();
    await dispatch();
    await meta().delete(tenant);
    expect(await sender().sweep()).toBe(0);
    expect(await statusOf(last.id)).toEqual(['skipped', 'Not sent: the shop disconnected Meta']);
  });

  it("sends an order to TikTok's Events API beside Meta's, each settled by what its platform said", async () => {
    unwrap(await meta().update(tenant, { pixelId: '1234567890', accessToken: TOKEN }));
    const tiktokToken = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    unwrap(
      await tiktok().update(tenant, {
        pixelCode: 'CABC123DEF456GHI789J',
        accessToken: tiktokToken,
        testEventCode: 'TEST31337',
        purchaseAt: 'confirmed',
      }),
    );
    const order = await placeOnline({
      attribution: {
        first: visits.first,
        last: {
          at: '2026-10-01T08:00:00.000Z',
          source: 'tiktok',
          utm: null,
          landingPage: '/products/kurta?ttclid=E.C.P.CjwBhz&utm_source=tiktok',
        },
      },
      browserIds: { ttp: '2RjN8g3hW6yFZ8JQ0Gk6p1Lq5Xv' },
    });
    await dispatch();
    const platforms = async () =>
      (
        await admin.query<{
          platform: string;
          moment: string;
          status: string;
          event_name: string | null;
          error: string | null;
          trace_id: string | null;
        }>(
          `SELECT platform, moment, status, event_name, error, trace_id FROM marketing.conversions
            WHERE order_id = $1 ORDER BY occurred_at, platform`,
          [order.id],
        )
      ).rows.map((row) => [
        row.platform,
        row.moment,
        row.status,
        row.event_name,
        row.error,
        row.trace_id,
      ]);
    expect(
      (await platforms()).map(([platform, moment, status]) => [platform, moment, status]),
    ).toEqual([
      ['meta', 'placed', 'pending'],
      ['tiktok', 'placed', 'pending'],
    ]);

    expect(await sender().sweep()).toBe(2);
    expect(
      requests.splice(0).map((request) => request.events.map((event) => event.event_name)),
    ).toEqual([['Purchase']]);
    const [request] = tiktokRequests.splice(0);
    expect(request!.url).toBe('/open_api/v1.3/event/track/');
    expect(request!.token).toBe(tiktokToken);
    expect(request!.body).toEqual({
      event_source: 'web',
      event_source_id: 'CABC123DEF456GHI789J',
      test_event_code: 'TEST31337',
      data: [
        {
          // Not its purchase: the shop counts that when the order is confirmed.
          event: 'PlaceAnOrder',
          event_time: expect.any(Number) as number,
          event_id: `order-${order.number}-placed`,
          user: {
            external_id: sha256(order.customerId),
            phone: sha256('+923001112223'),
            email: sha256('ayesha@example.com'),
            ip: '39.40.1.2',
            user_agent: 'Mozilla/5.0 (Linux; Android 14)',
            ttclid: 'E.C.P.CjwBhz',
            ttp: '2RjN8g3hW6yFZ8JQ0Gk6p1Lq5Xv',
          },
          properties: {
            currency: 'PKR',
            value: 5_000,
            order_id: String(order.number),
            content_type: 'product',
            contents: [
              { content_id: variantId, quantity: 2, price: 2_000 },
              { content_id: otherVariantId, quantity: 1, price: 750 },
            ],
          },
          page: { url: 'http://zari.localhost:4100/checkout' },
        },
      ],
    });
    expect(await platforms()).toEqual([
      ['meta', 'placed', 'sent', 'Purchase', null, 'AbC123'],
      ['tiktok', 'placed', 'sent', 'PlaceAnOrder', null, 'req-1'],
    ]);

    // TikTok over its limits for now: its moment waits, Meta's goes.
    unwrap(await orders().confirm(tenant, order.id));
    await dispatch();
    tiktokAnswer = {
      status: 200,
      body: { code: 40100, message: 'Too many requests', request_id: 'req-2' },
    };
    const now = new Date();
    expect(await sender().send(shopId, now)).toBe(1);
    expect((await platforms()).slice(2)).toEqual([
      ['meta', 'confirmed', 'sent', 'OrderConfirmed', null, 'AbC123'],
      ['tiktok', 'confirmed', 'pending', null, 'TikTok 40100: Too many requests', 'req-2'],
    ]);
    // A minute on, refused for good.
    tiktokAnswer = {
      status: 200,
      body: { code: 40002, message: 'Invalid event_source_id', request_id: 'req-3' },
    };
    expect(await sender().send(shopId, new Date(now.getTime() + 61_000))).toBe(0);
    expect(tiktokRequests.splice(0).map((each) => each.body.data[0]!.event)).toEqual([
      'CompletePayment',
      'CompletePayment',
    ]);
    expect((await platforms())[3]).toEqual([
      'tiktok',
      'confirmed',
      'failed',
      'CompletePayment',
      'TikTok 40002: Invalid event_source_id',
      'req-3',
    ]);

    // Disconnected with a moment waiting: it is not sent; Meta's still goes.
    const fulfillments = new FulfillmentService(database, new StockService());
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(tenant, order.id, {}));
    unwrap(await fulfillments.markDelivered(tenant, fulfillmentId));
    await dispatch();
    expect(await tiktok().delete(tenant)).toBe('CABC123DEF456GHI789J');
    requests.splice(0);
    expect(await sender().sweep()).toBe(1);
    expect(tiktokRequests).toEqual([]);
    expect(
      (await platforms())
        .slice(4)
        .map(([platform, , status, , error]) => [platform, status, error]),
    ).toEqual([
      ['meta', 'sent', null],
      ['tiktok', 'skipped', 'Not sent: the shop disconnected TikTok'],
    ]);
  });

  it("sends an order to Google Analytics, a request for each moment, within Google's three days", async () => {
    const secret = 'Xy9_kq2LmN0pQrStUvWz';
    unwrap(
      await google().update(tenant, {
        measurementId: 'g-ab12cd34ef',
        apiSecret: secret,
        purchaseAt: 'confirmed',
      }),
    );
    const order = await placeOnline({ browserIds: { ga: 'GA1.1.1903423857.1760680000' } });
    unwrap(await orders().confirm(tenant, order.id));
    await dispatch();
    const platforms = async () =>
      (
        await admin.query<{
          platform: string;
          moment: string;
          status: string;
          event_name: string | null;
          error: string | null;
        }>(
          `SELECT platform, moment, status, event_name, error FROM marketing.conversions
            WHERE order_id = $1 ORDER BY occurred_at, platform`,
          [order.id],
        )
      ).rows.map((row) => [row.platform, row.moment, row.status, row.event_name, row.error]);

    expect(await sender().sweep()).toBe(2);
    expect(googleRequests.map((request) => request.url)).toEqual([
      `/mp/collect?measurement_id=G-AB12CD34EF&api_secret=${secret}`,
      `/mp/collect?measurement_id=G-AB12CD34EF&api_secret=${secret}`,
    ]);
    const [placed, confirmed] = googleRequests.splice(0).map((request) => request.body);
    const customer = sha256(order.customerId);
    expect(placed).toEqual({
      // The browser Google's tag named (ADR-548).
      client_id: '1903423857.1760680000',
      user_id: customer,
      timestamp_micros: expect.any(Number) as number,
      user_data: {
        sha256_phone_number: [sha256('+923001112223')],
        sha256_email_address: [sha256('ayesha@example.com')],
      },
      events: [
        {
          // Not its purchase: the shop counts that when the order is confirmed.
          name: 'order_placed',
          params: {
            transaction_id: String(order.number),
            currency: 'PKR',
            value: 5_000,
            items: [
              { item_id: variantId, quantity: 2, price: 2_000 },
              { item_id: otherVariantId, quantity: 1, price: 750 },
            ],
          },
        },
      ],
    });
    expect(confirmed!.events[0]!.name).toBe('purchase');
    expect(await platforms()).toEqual([
      ['google', 'placed', 'sent', 'order_placed', null],
      ['google', 'confirmed', 'sent', 'purchase', null],
    ]);

    // Google in trouble: the moment waits; refused for good, it fails.
    const fulfillments = new FulfillmentService(database, new StockService());
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(tenant, order.id, {}));
    unwrap(await fulfillments.markDelivered(tenant, fulfillmentId));
    await dispatch();
    googleAnswer = { status: 503, body: 'Service Unavailable' };
    const now = new Date();
    expect(await sender().send(shopId, now)).toBe(0);
    expect((await platforms())[2]).toEqual([
      'google',
      'delivered',
      'pending',
      null,
      'Google 503: Service Unavailable',
    ]);
    googleAnswer = { status: 400, body: 'Bad Request' };
    expect(await sender().send(shopId, new Date(now.getTime() + 61_000))).toBe(0);
    expect((await platforms())[2]).toEqual([
      'google',
      'delivered',
      'failed',
      'order_delivered',
      'Google 400: Bad Request',
    ]);

    // Older than Google's three days by the time it could go: expired, not sent.
    const late = await placeOnline();
    await dispatch();
    googleRequests.splice(0);
    expect(await sender().send(shopId, new Date(Date.now() + 72 * 3_600_000))).toBe(0);
    expect(googleRequests).toEqual([]);
    expect((await statusOf(late.id))![1]).toBe(
      'Not sent: Google takes events up to three days after they happened',
    );

    // Disconnected with a moment waiting: it is not sent.
    const another = await placeOnline();
    await dispatch();
    expect(await google().delete(tenant)).toBe('G-AB12CD34EF');
    expect(await statusOf(another.id)).toEqual([
      'skipped',
      'Not sent: the shop disconnected Google',
    ]);
  });

  it('sends an order staff took from a chat to Meta alone, where the shop says so (ADR-655)', async () => {
    unwrap(await meta().update(tenant, { pixelId: '1234567890', accessToken: TOKEN }));
    unwrap(
      await tiktok().update(tenant, { pixelCode: 'CABC123DEF456GHI789J', accessToken: TOKEN }),
    );
    // Not sent until the shop says so.
    const before = await placeOnline({ attribution: null, agreement: null }, 'whatsapp');
    await dispatch();
    expect(await recorded()).toEqual([]);

    unwrap(await meta().update(tenant, { staffOrders: true }));
    const order = await placeOnline({ attribution: null, agreement: null }, 'whatsapp');
    await dispatch();
    // For Meta alone: TikTok takes events from the browser that placed an order.
    expect(await recorded()).toEqual([[order.id, 'placed', 'pending', null, null]]);
    expect(await sender().sweep()).toBe(1);
    const [event] = requests.splice(0)[0]!.events;
    expect(event).toMatchObject({
      event_name: 'Purchase',
      event_id: `order-${order.number}-placed`,
      action_source: 'chat',
      user_data: { ph: [sha256('923001112223')] },
    });
    // No page it was placed on, no browser.
    expect(event).not.toHaveProperty('event_source_url');
    expect(event!.user_data).not.toHaveProperty('client_ip_address');
    expect(tiktokRequests).toEqual([]);

    // Its later moments follow, as checkout's do; the order before stays unsent.
    unwrap(await orders().confirm(tenant, order.id));
    unwrap(await orders().confirm(tenant, before.id));
    await dispatch();
    expect(await sender().sweep()).toBe(1);
    expect(requests.splice(0)[0]!.events.map((each) => each.event_id)).toEqual([
      `order-${order.number}-confirmed`,
    ]);
  });

  it('reads the events that make moments', () => {
    expect(ConversionMoments.EVENTS).toEqual([
      'order.created',
      'order.confirmed',
      'order.paid',
      'fulfillment.updated',
    ]);
  });
});

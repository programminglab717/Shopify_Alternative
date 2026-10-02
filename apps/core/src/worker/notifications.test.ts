import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { createLogger } from '@hatti/logger';
import {
  MessagesService,
  MessagingSettingsService,
  SmsGatewayProvider,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MessageProvider,
} from '@hatti/messaging/public';
import { FulfillmentService, OrderEditService, type OrderToPlace } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessagesSender, OrderNotifications, messageRetryDelayMs } from './notifications.js';
import { eventHandlers } from './start-worker.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const AYESHA = '+923001112223';

describe.skipIf(!server)("What a shop's customers are told about their orders", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let provider: Server;
  let providerUrl: string;
  /** What the fake WhatsApp and SMS gateway were sent, and what they answer next. */
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const answers: { whatsapp: { status: number; body: unknown }[]; sms: { status: number }[] } = {
    whatsapp: [],
    sms: [],
  };
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_settings']),
  };
  let variantId: string;

  const messages = () => new MessagesService(database);
  const orders = () => workerOrders(database);
  const fulfillments = () => new FulfillmentService(database, new StockService());
  const whatsapp = () =>
    new WhatsAppCloudProvider({
      baseUrl: providerUrl,
      version: 'v26.0',
      phoneNumberId: '1098765432',
      accessToken: 'EAAG-system-user-token',
    });
  const sms = () =>
    new SmsGatewayProvider({ url: `${providerUrl}/sms`, apiKey: 'gateway-key', sender: 'Hatti' });
  const sender = (
    providers: Partial<Record<MessageChannel, MessageProvider>> = {
      whatsapp: whatsapp(),
      sms: sms(),
    },
  ) => new MessagesSender({ messages: messages(), providers });

  /** The events recorded since the last call, oldest first, handed to the worker's handlers. */
  const dispatch = async (times = 1): Promise<string[]> => {
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
    const registry = eventHandlers(createLogger({ name: 'worker', level: 'silent' }), {
      notifications: new OrderNotifications(database, messages()),
    });
    // At least once: the same event twice is one message.
    for (let time = 0; time < times; time++) {
      for (const event of events) await registry.dispatch(event);
    }
    return events.map((event) => event.type);
  };

  /** The shop's messages, the earliest first. */
  const queued = async () =>
    (
      await admin.query<{
        id: string;
        kind: string;
        channel: string;
        recipient: string;
        status: string;
        attempts: number;
        order_id: string | null;
        variables: Record<string, string>;
        error: string | null;
        replaces: string | null;
        provider_message_id: string | null;
      }>(
        `SELECT id, kind, channel, recipient, status, attempts, order_id, variables, error,
                replaces, provider_message_id
           FROM messaging.messages WHERE shop_id = $1 ORDER BY created_at, id`,
        [shopId],
      )
    ).rows;

  /** Places an order as checkout does, from the online store. */
  const placeOnline = async (overrides: Partial<OrderToPlace> = {}) => {
    const service = orders();
    return unwrap(
      await database.tenant(shopId, (tx) =>
        service.placeIn(
          tx,
          {
            shopId,
            currency: 'PKR',
            actor: 'system',
            source: 'online_store',
            how: 'from the online store',
          },
          {
            field: [],
            lines: [{ variantId, quantity: 2, price: null }],
            address: {
              name: '  Ayesha Khan',
              phone: AYESHA,
              address1: 'House 12, Street 4',
              address2: null,
              landmark: null,
              city: 'Rawalpindi',
              provinceCode: null,
              zip: null,
            },
            email: null,
            paymentMethod: 'cash_on_delivery',
            shipping: 250_00n,
            discount: 0n,
            advance: 0n,
            locationId: null,
            note: '',
            tags: [],
            agreement: { policyVersions: [], ip: null, userAgent: null },
            attribution: null,
            ...overrides,
          },
        ),
      ),
    );
  };

  /** One second on: what was queued now is due. */
  const soon = () => new Date(Date.now() + 1_000);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'notifications-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari Fashions', 'zari')`,
      [shopId],
    );
    const product = unwrap(
      await new ProductService(database).create(tenant, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,500' }],
      }),
    );
    variantId = product.variants[0]!.id;
    const location = await new LocationService(database).primary(tenant);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 100 }],
      }),
    );

    provider = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => {
        const url = request.url ?? '';
        requests.push({ url, body: JSON.parse(text) as Record<string, unknown> });
        const answer = url === '/sms' ? answers.sms.shift() : answers.whatsapp.shift();
        response.writeHead(answer?.status ?? 200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            answer && 'body' in answer
              ? answer.body
              : url === '/sms'
                ? { id: `sms-${requests.length}` }
                : { messages: [{ id: `wamid.${requests.length}` }] },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    requests.splice(0);
    answers.whatsapp.splice(0);
    answers.sms.splice(0);
    await dispatch();
    await admin.query(
      'DELETE FROM messaging.messages; DELETE FROM messaging.opt_outs; ' +
        'DELETE FROM messaging.settings',
    );
  });

  it('tells the customer their order was placed, each parcel shipped and delivered, once each', async () => {
    const order = await placeOnline();
    await dispatch(2);
    expect(
      (await queued()).map((message) => [message.kind, message.channel, message.recipient]),
    ).toEqual([['order_placed', 'whatsapp', AYESHA]]);
    expect((await queued())[0]!.variables).toEqual({
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${order.number}`,
      total: 'Rs 5,250',
    });

    // Shipped without a tracking number: news once it has one.
    unwrap(await orders().confirm(tenant, order.id));
    const { fulfillmentId } = unwrap(await fulfillments().fulfill(tenant, order.id, {}));
    await dispatch();
    expect((await queued()).map((message) => message.kind)).toEqual(['order_placed']);
    unwrap(
      await fulfillments().updateTracking(tenant, fulfillmentId, {
        company: 'PostEx',
        number: 'PX123456',
        url: 'https://postex.pk/track/PX123456',
      }),
    );
    await dispatch();
    // Corrected: still one message.
    unwrap(
      await fulfillments().updateTracking(tenant, fulfillmentId, {
        company: 'PostEx',
        number: 'PX123457',
        url: null,
      }),
    );
    await dispatch();
    unwrap(await fulfillments().markDelivered(tenant, fulfillmentId));
    await dispatch(2);
    const told = await queued();
    expect(told.map((message) => [message.kind, message.order_id])).toEqual([
      ['order_placed', order.id],
      ['order_shipped', order.id],
      ['order_delivered', order.id],
    ]);
    expect(told[1]!.variables).toEqual({
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${order.number}`,
      total: 'Rs 5,250',
      courier: 'PostEx',
      tracking: 'PX123456',
      url: 'https://postex.pk/track/PX123456',
    });

    // Shipped with its tracking: news at once. Delivered before the worker heard it was shipped:
    // delivered alone.
    const second = await placeOnline();
    const third = await placeOnline();
    unwrap(await orders().confirm(tenant, second.id));
    unwrap(await orders().confirm(tenant, third.id));
    unwrap(
      await fulfillments().fulfill(tenant, second.id, {
        tracking: { company: 'Leopards', number: 'LP9', url: null },
      }),
    );
    const late = unwrap(
      await fulfillments().fulfill(tenant, third.id, {
        tracking: { company: 'Leopards', number: 'LP10', url: null },
      }),
    );
    unwrap(await fulfillments().markDelivered(tenant, late.fulfillmentId));
    await dispatch();
    expect(
      (await queued())
        .filter((message) => message.order_id === second.id || message.order_id === third.id)
        .map((message) => [
          message.order_id === second.id ? 'second' : 'third',
          message.kind,
          message.variables.tracking,
        ]),
    ).toEqual([
      ['second', 'order_placed', undefined],
      ['third', 'order_placed', undefined],
      ['second', 'order_shipped', 'LP9'],
      ['third', 'order_delivered', 'LP10'],
    ]);
  });

  it('tells of an order cancelled, but not one merged, split, erased or turned off', async () => {
    const cancelled = await placeOnline();
    unwrap(await orders().cancel(tenant, cancelled.id, { reason: 'customer' }));
    const kept = await placeOnline();
    const merged = await placeOnline();
    await dispatch();
    await admin.query('DELETE FROM messaging.messages');

    const edits = new OrderEditService(
      database,
      new VariantService(database),
      new LocationService(database),
      new StockService(),
    );
    unwrap(await edits.merge(tenant, merged.id, kept.id));
    const { split } = unwrap(
      await edits.split(tenant, kept.id, {
        lineItems: [{ lineItemId: kept.lines[0]!.id, quantity: 1 }],
      }),
    );
    expect(split.id).not.toBe(kept.id);
    await dispatch();
    expect(await queued()).toEqual([]);

    // The order's customer was erased: no number to write to.
    const erased = await placeOnline();
    await admin.query(
      `UPDATE orders.orders SET phone = NULL, customer_erased_at = now() WHERE id = $1`,
      [erased.id],
    );
    // The shop turned cancellations off.
    unwrap(
      await new MessagingSettingsService(database).update(tenant, {
        disabled: ['order_cancelled'],
      }),
    );
    unwrap(await orders().cancel(tenant, kept.id, { reason: 'inventory' }));
    await dispatch();
    expect(await queued()).toEqual([]);

    // Turned on again: told.
    await admin.query('DELETE FROM messaging.settings');
    const again = await placeOnline();
    await dispatch();
    unwrap(await orders().cancel(tenant, again.id, { reason: 'no_response' }));
    await dispatch();
    expect((await queued()).map((message) => message.kind)).toEqual([
      'order_placed',
      'order_cancelled',
    ]);
  });

  it("sends on WhatsApp from Hatti's number, and by SMS what WhatsApp cannot deliver", async () => {
    await placeOnline();
    await placeOnline({ address: { ...addressOf('Bilal'), phone: '+923217654321' } });
    await placeOnline({ address: { ...addressOf('Sana'), phone: '+923335550001' } });
    await dispatch();
    // The first taken, the second refused for good, the third not yet.
    answers.whatsapp.push(
      { status: 200, body: { messages: [{ id: 'wamid.HBgM' }] } },
      { status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } },
      { status: 503, body: { error: { code: 2, message: 'Service unavailable' } } },
    );
    const at = soon();
    expect(await sender().sweep(at)).toBe(1);
    expect(requests.map((request) => request.url)).toEqual([
      '/v26.0/1098765432/messages',
      '/v26.0/1098765432/messages',
      '/v26.0/1098765432/messages',
    ]);
    expect(requests[0]!.body).toMatchObject({
      to: AYESHA.slice(1),
      template: { name: 'hatti_order_placed', language: { code: 'en' } },
    });
    let state = await queued();
    expect(state.map((message) => [message.channel, message.status, message.attempts])).toEqual([
      ['whatsapp', 'sent', 1],
      ['whatsapp', 'failed', 1],
      ['whatsapp', 'pending', 1],
      ['sms', 'pending', 0],
    ]);
    expect(state[0]!.provider_message_id).toBe('wamid.HBgM');
    expect(state[1]!.error).toBe('WhatsApp 131026: Message undeliverable');
    expect(state[2]!.error).toBe('WhatsApp 2: Service unavailable');
    expect(state[3]!.replaces).toBe(state[1]!.id);

    // A minute on: the SMS in place of the one refused, and the one not taken tried again.
    requests.splice(0);
    expect(await sender().sweep(new Date(at.getTime() + messageRetryDelayMs(1)))).toBe(2);
    expect(requests.map((request) => request.url).sort()).toEqual([
      '/sms',
      '/v26.0/1098765432/messages',
    ]);
    expect(requests.find((request) => request.url === '/sms')!.body).toMatchObject({
      to: '+923217654321',
      sender: 'Hatti',
      text: expect.stringContaining('Zari Fashions'),
    });
    state = await queued();
    expect(state.map((message) => [message.channel, message.status, message.attempts])).toEqual([
      ['whatsapp', 'sent', 1],
      ['whatsapp', 'failed', 1],
      ['whatsapp', 'sent', 2],
      ['sms', 'sent', 1],
    ]);

    // WhatsApp took the first and has not delivered it for 15 minutes: an SMS too, once.
    await admin.query(
      `UPDATE messaging.messages SET sent_at = now() - interval '16 minutes' WHERE id = $1`,
      [state[0]!.id],
    );
    requests.splice(0);
    // Queued and sent in the same round, once.
    expect(await sender().sweep(soon())).toBe(1);
    expect(await sender().sweep(new Date(Date.now() + 2_000))).toBe(0);
    expect(requests.map((request) => [request.url, request.body.to])).toEqual([['/sms', AYESHA]]);
  });

  it("skips those who asked the shop to stop, gives up after a day, and fails what can't go", async () => {
    await placeOnline();
    await placeOnline({ address: { ...addressOf('Bilal'), phone: '+923217654321' } });
    await placeOnline({ address: { ...addressOf('Sana'), phone: '+923335550001' } });
    await dispatch();
    const [, bilal, sana] = await queued();
    await admin.query(
      `INSERT INTO messaging.opt_outs (shop_id, channel, recipient, said)
       VALUES ($1, 'whatsapp', $2, 'band karo')`,
      [shopId, AYESHA],
    );
    await admin.query(
      `UPDATE messaging.messages SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [bilal!.id],
    );
    // No WhatsApp number set up: Sana's goes by SMS.
    expect(await sender({ sms: sms() }).sweep(soon())).toBe(0);
    expect(requests).toEqual([]);
    expect(
      (await queued()).map((message) => [message.channel, message.status, message.error]),
    ).toEqual([
      // Queued a day ago.
      ['whatsapp', 'failed', 'Not sent within a day'],
      ['whatsapp', 'skipped', 'Not sent: the customer asked the shop to stop'],
      ['whatsapp', 'failed', 'No WhatsApp number is set up'],
      ['sms', 'pending', null],
    ]);
    expect(await sender({ sms: sms() }).sweep(new Date(Date.now() + 2_000))).toBe(1);
    expect(requests.map((request) => request.body.to)).toEqual([sana!.recipient]);

    // An SMS the gateway refuses fails, with nothing in its place.
    await admin.query('DELETE FROM messaging.messages');
    await new MessagingSettingsService(database).update(tenant, { routing: 'economy' });
    await placeOnline({ address: { ...addressOf('Sana'), phone: '+923335550001' } });
    await dispatch();
    answers.sms.push({ status: 400 });
    requests.splice(0);
    await sender().sweep(soon());
    expect(
      (await queued()).map((message) => [message.channel, message.status, message.error]),
    ).toEqual([['sms', 'failed', 'SMS gateway 400: no reason given']]);
  });
});

function addressOf(name: string): OrderToPlace['address'] {
  return {
    name,
    phone: AYESHA,
    address1: 'House 1',
    address2: null,
    landmark: null,
    city: 'Lahore',
    provinceCode: null,
    zip: null,
  };
}

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { BillingService, MessageWallet } from '@hatti/billing/public';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import {
  InventoryService,
  LocationService,
  LowStockService,
  StockService,
} from '@hatti/inventory/public';
import { createLogger } from '@hatti/logger';
import {
  MessagesService,
  MessagingSettingsService,
  SmsGatewayProvider,
  WhatsAppCloudProvider,
  type MessageChannel,
  type MessageProvider,
} from '@hatti/messaging/public';
import {
  CustomerAnswers,
  FulfillmentService,
  OrderEditService,
  type OrderToPlace,
} from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LowStockAlerts } from './low-stock-alerts.js';
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
      notifications: new OrderNotifications(
        database,
        messages(),
        new PublicSite('https://hatti.pk'),
        new CustomerAnswers(database, orders()),
      ),
      lowStock: new LowStockAlerts(
        database,
        new LowStockService(database, new VariantService(database)),
        messages(),
      ),
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

  /** Orders placed say so, as where the shop asks for no confirmations. */
  const withoutConfirmations = async () =>
    unwrap(
      await new MessagingSettingsService(database).update(tenant, {
        disabled: ['order_confirmation'],
      }),
    );

  /** The order's timeline, as [kind, message], the earliest first. */
  const timeline = async (orderId: string) =>
    (
      await admin.query<{ kind: string; message: string }>(
        'SELECT kind, message FROM orders.order_events WHERE order_id = $1 ORDER BY created_at, id',
        [orderId],
      )
    ).rows.map((row) => [row.kind, row.message]);

  /** Whether the order's link is the one `url` names. */
  const linkOf = async (orderId: string, url: string) => {
    const { rows } = await admin.query<{ link_token_hash: Buffer | null }>(
      'SELECT link_token_hash FROM orders.orders WHERE id = $1',
      [orderId],
    );
    const token = url.split('/').pop()!;
    return rows[0]?.link_token_hash?.equals(createHash('sha256').update(token).digest()) ?? false;
  };

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
        'DELETE FROM messaging.settings; DELETE FROM billing.wallet_entries; ' +
        'DELETE FROM billing.wallets; DELETE FROM inventory.low_stock_spells',
    );
  });

  it('tells the customer their order was placed, each parcel shipped and delivered, once each', async () => {
    const order = await placeOnline();
    await dispatch(2);
    // Cash on delivery, waiting for them: asked to confirm it, with its link, made once.
    expect(
      (await queued()).map((message) => [message.kind, message.channel, message.recipient]),
    ).toEqual([['order_confirmation', 'whatsapp', AYESHA]]);
    const [asked] = await queued();
    expect(asked!.variables).toEqual({
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${order.number}`,
      total: 'Rs 5,250',
      url: expect.stringMatching(/^https:\/\/hatti\.pk\/o\/[\w-]{22}$/),
    });
    expect(await linkOf(order.id, asked!.variables.url!)).toBe(true);
    expect((await timeline(order.id)).filter(([kind]) => kind === 'link')).toEqual([
      ['link', 'Sent the customer a link with the message asking them to confirm the order'],
    ]);

    // Confirmed by the shop on a call: told so. Shipped without a tracking number: news once it
    // has one.
    unwrap(await orders().confirm(tenant, order.id));
    const { fulfillmentId } = unwrap(await fulfillments().fulfill(tenant, order.id, {}));
    await dispatch(2);
    expect((await queued()).map((message) => message.kind)).toEqual([
      'order_confirmation',
      'order_confirmed',
    ]);
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
      ['order_confirmation', order.id],
      ['order_confirmed', order.id],
      ['order_shipped', order.id],
      ['order_delivered', order.id],
    ]);
    expect(told[2]!.variables).toEqual({
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
      // Confirmed before the worker heard they were placed: nothing to ask.
      ['second', 'order_placed', undefined],
      ['third', 'order_placed', undefined],
      ['second', 'order_confirmed', undefined],
      ['third', 'order_confirmed', undefined],
      ['second', 'order_shipped', 'LP9'],
      ['third', 'order_delivered', 'LP10'],
    ]);
  });

  it('does as the customer answers on WhatsApp: confirms, cancels, or sends the page to change the address', async () => {
    const ayesha = await placeOnline();
    const bilal = await placeOnline({ address: { ...addressOf('Bilal'), phone: '+923217654321' } });
    const sana = await placeOnline({ address: { ...addressOf('Sana'), phone: '+923335550001' } });
    await dispatch();
    expect(await sender().sweep(soon())).toBe(3);
    // Its buttons answer with what they mean, whatever their words.
    expect(requests[0]!.body).toMatchObject({
      to: AYESHA.slice(1),
      template: {
        name: 'hatti_order_confirmation',
        components: [
          { type: 'body' },
          ...['confirm', 'cancel', 'address'].map((payload, index) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(index),
            parameters: [{ type: 'payload', payload }],
          })),
        ],
      },
    });
    const [toAyesha, toBilal, toSana] = await queued();
    const answer = (to: { provider_message_id: string | null; recipient: string }, said: string) =>
      messages().recordReply({
        replyTo: to.provider_message_id!,
        from: to.recipient,
        answer: said,
        at: new Date(),
      });
    expect(await answer(toAyesha!, 'confirm')).toBe(true);
    expect(await answer(toBilal!, 'cancel')).toBe(true);
    expect(await answer(toSana!, 'address')).toBe(true);
    // Not theirs to answer.
    expect(await answer({ ...toSana!, recipient: '+923009998887' }, 'cancel')).toBe(false);
    expect(await answer({ ...toSana!, provider_message_id: 'wamid.gone' }, 'cancel')).toBe(false);
    // Heard twice, as webhooks are: done once.
    await dispatch(2);
    await dispatch();

    const state = async (id: string) =>
      (
        await admin.query<{ status: string; confirmation_status: string; cancel_reason: string }>(
          'SELECT status, confirmation_status, cancel_reason FROM orders.orders WHERE id = $1',
          [id],
        )
      ).rows[0];
    expect(await state(ayesha.id)).toEqual({
      status: 'open',
      confirmation_status: 'confirmed',
      cancel_reason: null,
    });
    expect(await state(bilal.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'customer' });
    expect(await state(sana.id)).toMatchObject({ status: 'open', confirmation_status: 'pending' });
    expect((await timeline(ayesha.id)).at(-1)).toEqual([
      'confirmed',
      'Confirmed by the customer on WhatsApp',
    ]);
    expect(await timeline(bilal.id)).toContainEqual([
      'cancelled',
      'Cancelled by the customer on WhatsApp',
    ]);
    expect((await timeline(sana.id)).filter(([kind]) => kind === 'customer_request')).toEqual([
      ['customer_request', 'The customer asked on WhatsApp to change the address'],
    ]);
    const told = await queued();
    expect(told.map((message) => [message.order_id, message.kind])).toEqual([
      [ayesha.id, 'order_confirmation'],
      [bilal.id, 'order_confirmation'],
      [sana.id, 'order_confirmation'],
      [sana.id, 'order_address'],
      [ayesha.id, 'order_confirmed'],
      [bilal.id, 'order_cancelled'],
    ]);
    // The page the message asking them linked: still the order's.
    const page = told[3]!.variables.url!;
    expect(page).toBe(toSana!.variables.url);
    expect(await linkOf(sana.id, page)).toBe(true);
    requests.splice(0);
    await sender().sweep(soon());
    expect(
      requests.find((request) => request.body.to === toSana!.recipient.slice(1))!.body,
    ).toMatchObject({
      template: {
        name: 'hatti_order_address',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: `#${sana.number}` }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: page.split('/').pop() }],
          },
        ],
      },
    });

    // Packed: too late to cancel themselves; the shop sees they asked.
    unwrap(await orders().markPacked(tenant, ayesha.id));
    expect(await answer(toAyesha!, 'cancel')).toBe(true);
    await dispatch();
    expect(await state(ayesha.id)).toMatchObject({ status: 'open' });
    expect((await timeline(ayesha.id)).at(-1)).toEqual([
      'customer_request',
      'The customer asked on WhatsApp to cancel the order, too late to cancel it themselves',
    ]);
  });

  it('asks by SMS, with the link, when WhatsApp cannot deliver the question', async () => {
    const order = await placeOnline();
    await dispatch();
    answers.whatsapp.push({
      status: 400,
      body: { error: { code: 131026, message: 'Message undeliverable' } },
    });
    await sender().sweep(soon());
    await sender().sweep(new Date(Date.now() + 2_000));
    const [asked, sms] = await queued();
    expect(sms).toMatchObject({ channel: 'sms', kind: 'order_confirmation', status: 'sent' });
    const text = requests.find((request) => request.url === '/sms')!.body.text as string;
    expect(text).toContain(`#${order.number}`);
    expect(text.endsWith(` ${asked!.variables.url}`)).toBe(true);
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
      'order_confirmation',
      'order_cancelled',
    ]);
  });

  it("sends on WhatsApp from Hatti's number, and by SMS what WhatsApp cannot deliver", async () => {
    await withoutConfirmations();
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
    await withoutConfirmations();
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

  it("pays each message from the shop's credit, waits while it can't, and sends no code it can't pay for", async () => {
    await withoutConfirmations();
    const wallet = new MessageWallet(database);
    const paying = () =>
      new MessagesSender({
        messages: new MessagesService(database, wallet),
        providers: { whatsapp: whatsapp(), sms: sms() },
        charges: wallet,
      });
    await placeOnline();
    await placeOnline({ address: { ...addressOf('Bilal'), phone: '+923217654321' } });
    await dispatch();
    // A code a shopper asked for at checkout.
    await messages().queue(shopId, {
      kind: 'one_time_code',
      recipient: '+923335550001',
      channel: 'whatsapp',
      dedupeKey: `one_time_code:${newId()}`,
      variables: { shop: 'Zari Fashions', code: '048213' },
    });

    // No credit: the orders' news waits, a minute on; the code, which works for minutes, fails.
    const at = soon();
    expect(await paying().sweep(at)).toBe(0);
    expect(requests).toEqual([]);
    const waiting = "Waiting for the shop's message credit";
    expect(
      (await queued()).map((message) => [message.kind, message.status, message.error]),
    ).toEqual([
      ['order_placed', 'pending', waiting],
      ['order_placed', 'pending', waiting],
      ['one_time_code', 'failed', "Not sent: the shop's message credit ran out"],
    ]);

    // Rs 5 given: one message's worth, Rs 4.62. The other waits on, two minutes now.
    await new BillingService(database, new PublicSite('https://hatti.pk')).grantCredits(
      shopId,
      5_00n,
      'To try messages with',
    );
    expect(await paying().sweep(new Date(at.getTime() + 61_000))).toBe(1);
    expect(requests).toHaveLength(1);
    const [first, second] = await queued();
    expect([first!.status, second!.status, second!.error]).toEqual(['sent', 'pending', waiting]);
    expect(await wallet.balanceOf(shopId)).toBe(38n);
    const { rows: entries } = await admin.query<{
      kind: string;
      amount: string;
      message_id: string | null;
      channel: string | null;
    }>(
      `SELECT kind, amount::text, message_id, channel FROM billing.wallet_entries
        WHERE shop_id = $1 ORDER BY created_at, id`,
      [shopId],
    );
    expect(entries).toEqual([
      { kind: 'grant', amount: '500', message_id: null, channel: null },
      { kind: 'message', amount: '-462', message_id: first!.id, channel: 'whatsapp' },
    ]);
    // Without a wallet, as where none is set up, messages go unpaid for.
    expect(await sender().sweep(new Date(at.getTime() + 4 * 60_000))).toBe(1);
    expect(await wallet.balanceOf(shopId)).toBe(38n);
  });

  it('tells the shop when a variant runs low, and when it runs out, at its alerts number', async () => {
    const location = await new LocationService(database).primary(tenant);
    const stock = async (quantity: number) => {
      unwrap(
        await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
          name: 'available',
          reason: 'cycle_count_available',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
        }),
      );
      await dispatch(2);
    };
    const alerts = async () =>
      (await queued()).map((message) => [
        message.kind,
        message.channel,
        message.recipient,
        message.order_id,
        message.variables,
      ]);
    // Without an alerts number, nothing is sent.
    await stock(3);
    expect(await queued()).toEqual([]);
    await stock(50);

    const OWNER = '+923335550009';
    unwrap(await new MessagingSettingsService(database).update(tenant, { alertsPhone: OWNER }));
    await stock(4);
    const low = { shop: 'Zari Fashions', product: 'Kurta', stock: '4' };
    expect(await alerts()).toEqual([['stock_low', 'whatsapp', OWNER, null, low]]);
    // Lower still: told once a spell; out: told once more.
    await stock(2);
    await stock(0);
    expect(await alerts()).toEqual([
      ['stock_low', 'whatsapp', OWNER, null, low],
      ['stock_out', 'whatsapp', OWNER, null, { ...low, stock: '0' }],
    ]);
    // Stocked again, then low again: a spell of its own.
    await stock(100);
    await stock(1);
    expect((await alerts()).map(([kind]) => kind)).toEqual(['stock_low', 'stock_out', 'stock_low']);
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

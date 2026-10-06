import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicSite, type MutationResult, type StaffRole, type TenantContext } from '@hatti/api';
import { BillingService, MessageWallet } from '@hatti/billing/public';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { StoreCreditService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { appendEvent, type DomainEvent } from '@hatti/events';
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
  type OutgoingMessage,
} from '@hatti/messaging/public';
import {
  BankTransferService,
  CustomerAnswers,
  FulfillmentService,
  OrderCommentService,
  OrderEditService,
  type OrderToPlace,
} from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BillingNotices } from './billing-notices.js';
import { LowStockAlerts } from './low-stock-alerts.js';
import {
  MessagesSender,
  OrderNotifications,
  messageRetryDelayMs,
  shopTime,
} from './notifications.js';
import { StaffAlerts } from './staff-alerts.js';
import { StoreCreditExpiry } from './store-credit-expiry.js';
import { StoreCreditNotices } from './store-credit-notices.js';
import { eventHandlers } from './start-worker.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const AYESHA = '+923001112223';
const DAY = 24 * 3_600_000;

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
      billing: new BillingNotices(database, messages()),
      staff: new StaffAlerts(database, messages()),
      storeCredit: new StoreCreditNotices(database, messages()),
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

    // Each message the provider takes gets an ID of its own, however often `requests` is emptied:
    // two messages with one ID would make a reply's message one or the other.
    let sent = 0;
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
                ? { id: `sms-${(sent += 1)}` }
                : { messages: [{ id: `wamid.${(sent += 1)}` }] },
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
        'DELETE FROM billing.wallets; DELETE FROM billing.payments; ' +
        'DELETE FROM billing.invoices; DELETE FROM billing.subscriptions; ' +
        'DELETE FROM inventory.low_stock_spells',
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
    // Shipped: its tracking, and the order's page, where its way shows (ADR-160): the link the
    // customer has already, not a new one.
    expect(told[2]!.variables).toEqual({
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${order.number}`,
      total: 'Rs 5,250',
      courier: 'PostEx',
      tracking: 'PX123456',
      url: asked!.variables.url,
    });
    expect(await linkOf(order.id, asked!.variables.url!)).toBe(true);
    expect((await timeline(order.id)).filter(([kind]) => kind === 'link')).toHaveLength(1);
    expect(told[3]!.variables.url).toBeUndefined();

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

  it('tells the customer what to keep ready each time a parcel goes out for delivery, with its page', async () => {
    await withoutConfirmations();
    const order = await placeOnline();
    unwrap(await orders().confirm(tenant, order.id));
    const { fulfillmentId } = unwrap(
      await fulfillments().fulfill(tenant, order.id, {
        tracking: { company: 'PostEx', number: 'PX777', url: null },
      }),
    );
    let source = 0;
    const step = (status: 'in_transit' | 'out_for_delivery' | 'attempted_delivery') =>
      fulfillments().recordEvent({ shopId, actor: 'system' }, fulfillmentId, {
        status,
        message: null,
        sourceKey: `test:${++source}`,
      });
    unwrap(await step('in_transit'));
    unwrap(await step('out_for_delivery'));
    await dispatch(2);
    const told = await queued();
    expect(told.map((message) => message.kind)).toEqual([
      'order_placed',
      'order_confirmed',
      'order_shipped',
      'order_out_for_delivery',
    ]);
    const [, , shipped, out] = told;
    // The shipped message made the order's link; the next carries the same.
    expect(shipped!.variables.url).toMatch(/^https:\/\/hatti\.pk\/o\/[\w-]{22}$/);
    expect(out!.variables).toEqual({
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${order.number}`,
      total: 'Rs 5,250',
      due: 'Rs 5,250',
      courier: 'PostEx',
      tracking: 'PX777',
      url: shipped!.variables.url,
    });
    expect(await linkOf(order.id, out!.variables.url!)).toBe(true);
    expect((await timeline(order.id)).filter(([kind]) => kind === 'link')).toEqual([
      ['link', 'Sent the customer a link with the message that it was shipped'],
    ]);
    expect((await timeline(order.id)).filter(([kind]) => kind === 'parcel_event')).toEqual([
      ['parcel_event', 'On its way · PostEx PX777'],
      ['parcel_event', 'Out for delivery · PostEx PX777'],
    ]);
    // On WhatsApp: what to pay, and a button to its page.
    requests.splice(0);
    await sender().sweep(soon());
    const sent = requests.find(
      (request) =>
        (request.body.template as { name?: string } | undefined)?.name ===
        'hatti_order_out_for_delivery',
    );
    expect(sent!.body).toMatchObject({
      to: AYESHA.slice(1),
      template: {
        components: [
          {
            type: 'body',
            parameters: ['Zari Fashions', `#${order.number}`, 'Rs 5,250'].map((text) => ({
              type: 'text',
              text,
            })),
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: out!.variables.url!.split('/').pop() }],
          },
        ],
      },
    });

    // Tried and out again the next day: told again. Delivered: late news tells nothing.
    unwrap(await step('attempted_delivery'));
    unwrap(await step('out_for_delivery'));
    await dispatch();
    unwrap(await fulfillments().markDelivered(tenant, fulfillmentId));
    unwrap(await step('out_for_delivery'));
    await dispatch();
    const outs = (await queued()).filter((message) => message.kind === 'order_out_for_delivery');
    expect(outs).toHaveLength(2);
    expect(outs[1]!.variables.url).toBe(shipped!.variables.url);

    // Paid already: nothing to keep ready, so nothing to say.
    const paid = await placeOnline();
    unwrap(await orders().confirm(tenant, paid.id));
    unwrap(await orders().markAsPaid(tenant, paid.id));
    const parcel = unwrap(await fulfillments().fulfill(tenant, paid.id, {}));
    unwrap(
      await fulfillments().recordEvent({ shopId, actor: 'system' }, parcel.fulfillmentId, {
        status: 'out_for_delivery',
      }),
    );
    await dispatch();
    expect(
      (await queued()).filter(
        (message) => message.order_id === paid.id && message.kind === 'order_out_for_delivery',
      ),
    ).toEqual([]);
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

  it('asks once more those who have not answered, with the same buttons and link, and hears them (ADR-175)', async () => {
    const order = await placeOnline();
    await dispatch();
    const [first] = await queued();
    expect(first!.kind).toBe('order_confirmation');
    // At noon in Karachi, seven hours after it was placed, the sweep asks again. The noon is days
    // ahead, so that the orders the tests before placed are too old to be asked.
    const day = new Date(Date.now() + 5 * 86_400_000);
    const noon = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 7));
    await admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      order.id,
      new Date(noon.getTime() - 7 * 3_600_000),
    ]);
    expect(await orders().remindToConfirm(shopId, noon)).toBe(1);
    await dispatch(2);
    const [, again, ...more] = await queued();
    expect(more).toEqual([]);
    expect([again!.kind, again!.recipient, again!.variables]).toEqual([
      'order_confirmation_reminder',
      AYESHA,
      { ...first!.variables, url: first!.variables.url },
    ]);
    // The same buttons, from Hatti's number.
    expect(await sender().sweep(soon())).toBe(2);
    expect(requests[1]!.body).toMatchObject({
      template: {
        name: 'hatti_order_confirmation_reminder',
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
    // Its answer is heard as the first ask's would be.
    const [, sent] = await queued();
    expect(
      await messages().recordReply({
        replyTo: sent!.provider_message_id!,
        from: sent!.recipient,
        answer: 'confirm',
        at: new Date(),
      }),
    ).toBe(true);
    await dispatch(2);
    expect((await timeline(order.id)).at(-1)).toEqual([
      'confirmed',
      'Confirmed by the customer on WhatsApp',
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

  it("emails an order's news to the address its customer gave too, at no cost to the shop (ADR-181)", async () => {
    const order = await placeOnline({ email: 'Ayesha@Example.pk' });
    // None given: nothing more.
    await placeOnline();
    await dispatch(2);
    /** The order's messages as "kind channel recipient url", in order of kind and channel. */
    const told = async () =>
      (await queued())
        .filter((message) => message.order_id === order.id)
        .map((message) =>
          [message.kind, message.channel, message.recipient, message.variables.url].join(' '),
        )
        .sort();
    const [asked] = await queued();
    const link = asked!.variables.url!;
    expect(link).toMatch(/^https:\/\/hatti\.pk\/o\/[\w-]{22}$/);
    // Asked to confirm it, with its link, by email as on WhatsApp.
    expect(await told()).toEqual([
      `order_confirmation email ayesha@example.pk ${link}`,
      `order_confirmation whatsapp ${AYESHA} ${link}`,
    ]);

    // With no credit, the WhatsApp messages wait; the email, never charged, goes.
    const wallet = new MessageWallet(database);
    const emailed: OutgoingMessage[] = [];
    const email: MessageProvider = {
      name: 'test_email',
      channel: 'email',
      send: async (message) => {
        emailed.push(message);
        return { ok: true, providerMessageId: `email-${emailed.length}` };
      },
    };
    const paying = new MessagesSender({
      messages: new MessagesService(database, wallet),
      providers: { whatsapp: whatsapp(), sms: sms(), email },
      charges: wallet,
    });
    expect(await paying.sweep(soon())).toBe(1);
    expect(requests).toEqual([]);
    expect(emailed.map((message) => [message.kind, message.recipient, message.variables])).toEqual([
      [
        'order_confirmation',
        'ayesha@example.pk',
        {
          name: 'Ayesha',
          shop: 'Zari Fashions',
          order: `#${order.number}`,
          total: 'Rs 5,250',
          url: link,
          // Laid out as the shop's own, with its lines (ADR-198); it set no colour or logo yet.
          items: 'Kurta × 2\tRs 5,000',
        },
      ],
    ]);
    expect(
      (await queued()).map((message) => `${message.channel} ${message.status}`).sort(),
    ).toEqual(['email sent', 'whatsapp pending', 'whatsapp pending']);
    const { rows: entries } = await admin.query('SELECT 1 FROM billing.wallet_entries');
    expect(entries).toEqual([]);

    // Its logo set, the emails after show it, from the API's own address for it.
    const logo = newId();
    await admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
       VALUES ($1, $2, $3, 'logo.png', 'image/png', 2048, 'ready')`,
      [shopId, logo, `shops/${shopId}/files/${logo}/logo.png`],
    );
    await admin.query('INSERT INTO files.brands (shop_id, logo_file_id) VALUES ($1, $2)', [
      shopId,
      logo,
    ]);
    // Confirmed and shipped: each by email too, the shipping with the same link.
    unwrap(await orders().confirm(tenant, order.id));
    unwrap(
      await fulfillments().fulfill(tenant, order.id, {
        tracking: { company: 'PostEx', number: 'PX123456', url: null },
      }),
    );
    await dispatch(2);
    expect(await told()).toEqual([
      `order_confirmation email ayesha@example.pk ${link}`,
      `order_confirmation whatsapp ${AYESHA} ${link}`,
      'order_confirmed email ayesha@example.pk ',
      `order_confirmed whatsapp ${AYESHA} `,
      `order_shipped email ayesha@example.pk ${link}`,
      `order_shipped whatsapp ${AYESHA} ${link}`,
    ]);
    const shipped = (await queued()).find(
      (message) => message.kind === 'order_shipped' && message.channel === 'email',
    );
    expect(shipped!.variables).toMatchObject({
      logo: `https://hatti.pk/logos/${shopId}`,
      items: 'Kurta × 2\tRs 5,000',
    });
    // No email service set up: they fail, saying so.
    await sender().sweep(new Date(Date.now() + 2_000));
    expect(
      (await queued())
        .filter((message) => message.channel === 'email' && message.status === 'failed')
        .map((message) => [message.kind, message.error])
        .sort(),
    ).toEqual([
      ['order_confirmed', 'No email service is set up'],
      ['order_shipped', 'No email service is set up'],
    ]);
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

  it('tells the customer the shop has their payment before the order ships, not the cash paid at the door', async () => {
    await withoutConfirmations();
    // Stocked whatever the tests before it left.
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(tenant, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [
          {
            inventoryItemId: variantId,
            locationId: (await new LocationService(database).primary(tenant)).id,
            quantity: 100,
          },
        ],
      }),
    );
    const paid = async () =>
      (await queued())
        .filter((message) => message.kind === 'order_paid' || message.kind === 'order_advance_paid')
        .map((message) => [message.kind, message.order_id, message.channel, message.variables]);
    // Paid by transfer in full: told once, however often it is heard.
    const byTransfer = await placeOnline({ paymentMethod: 'bank_transfer' });
    unwrap(await orders().markAsPaid(tenant, byTransfer.id));
    await dispatch(2);
    const told = {
      name: 'Ayesha',
      shop: 'Zari Fashions',
      order: `#${byTransfer.number}`,
      total: 'Rs 5,250',
      amount: 'Rs 5,250',
    };
    expect(await paid()).toEqual([['order_paid', byTransfer.id, 'whatsapp', told]]);

    // Paying on delivery, its advance in: what is left for the rider. Part of it alone: nothing.
    unwrap(
      await new BankTransferService(database).update(tenant, {
        enabled: true,
        account: {
          title: 'Zari Fashions',
          bankName: 'Meezan Bank',
          iban: 'PK36 SCBL 0000 0011 2345 6702',
        },
      }),
    );
    const withAdvance = await placeOnline({ advanceDue: 500_00n });
    unwrap(await orders().recordPayment(tenant, withAdvance.id, { amount: '200' }));
    await dispatch(2);
    expect(await paid()).toHaveLength(1);
    unwrap(await orders().recordPayment(tenant, withAdvance.id, { amount: '300' }));
    await dispatch(2);
    expect((await paid())[1]).toEqual([
      'order_advance_paid',
      withAdvance.id,
      'whatsapp',
      {
        name: 'Ayesha',
        shop: 'Zari Fashions',
        order: `#${withAdvance.number}`,
        total: 'Rs 5,250',
        amount: 'Rs 500',
        due: 'Rs 4,750',
      },
    ]);

    // Cash paid at the door once its parcel is delivered: no news to whoever paid it.
    const atTheDoor = await placeOnline();
    unwrap(await orders().confirm(tenant, atTheDoor.id));
    const shipped = unwrap(
      await fulfillments().fulfill(tenant, atTheDoor.id, {
        tracking: { company: 'PostEx', number: 'PX77', url: null },
      }),
    );
    unwrap(await fulfillments().markDelivered(tenant, shipped.fulfillmentId));
    unwrap(await orders().markAsPaid(tenant, atTheDoor.id));
    await dispatch(2);
    expect(await paid()).toHaveLength(2);
    expect(
      (await queued())
        .filter((message) => message.order_id === atTheDoor.id)
        .map((message) => message.kind),
      // Delivered before the worker heard it was shipped: delivered alone.
    ).toEqual(['order_placed', 'order_confirmed', 'order_delivered']);
  });

  it('reminds the customer to pay a day before an unpaid order is cancelled, with its page (ADR-174)', async () => {
    const service = orders();
    const reminders = async () =>
      (await queued())
        .filter((message) => message.kind === 'order_payment_reminder')
        .map((message) => ({ orderId: message.order_id, variables: message.variables }));
    const waiting = await placeOnline({ paymentMethod: 'bank_transfer' });
    const paidSince = await placeOnline({ paymentMethod: 'bank_transfer' });
    await dispatch();
    // Cancelled after two days: a day and a half on, both are reminded; one is paid meanwhile.
    const placedAt = (await service.get(tenant, waiting.id))!.createdAt;
    expect(await service.remindUnpaid(shopId, 2, new Date(Date.now() + 36 * 3_600_000))).toBe(2);
    unwrap(await service.markAsPaid(tenant, paidSince.id));
    await dispatch(2);
    const [told, ...others] = await reminders();
    expect(others).toEqual([]);
    expect(told).toEqual({
      orderId: waiting.id,
      variables: {
        name: 'Ayesha',
        shop: 'Zari Fashions',
        order: `#${waiting.number}`,
        total: 'Rs 5,250',
        amount: 'Rs 5,250',
        date: shopTime('Asia/Karachi', new Date(placedAt.getTime() + 2 * 86_400_000)),
        url: expect.stringMatching(/^https:\/\/hatti\.pk\/o\/[\w-]{22}$/),
      },
    });
    expect(await linkOf(waiting.id, told!.variables.url!)).toBe(true);
    expect((await timeline(waiting.id)).filter(([kind]) => kind === 'link')).toEqual([
      ['link', 'Sent the customer a link with the message reminding them to pay'],
    ]);
  });

  it("tells the shop of its bills with Hatti at its alerts number, at Hatti's cost", async () => {
    const billing = new BillingService(database, new PublicSite('https://hatti.pk'));
    const wallet = new MessageWallet(database);
    const whatsappUtility = { channel: 'whatsapp', category: 'utility', parts: 1 } as const;
    const charge = async (times = 1) => {
      for (let time = 0; time < times; time++) {
        await database.tenant(shopId, (tx) =>
          wallet.chargeIn(tx, shopId, newId(), whatsappUtility),
        );
      }
    };
    const notices = async () =>
      (await queued()).map((message) => [
        message.kind,
        message.channel,
        message.recipient,
        message.variables,
      ]);
    // Without an alerts number, nothing is sent.
    await billing.grantCredits(shopId, 101_00n, 'To try messages with');
    await charge();
    await dispatch();
    expect(await queued()).toEqual([]);

    const OWNER = '+923335550009';
    unwrap(await new MessagingSettingsService(database).update(tenant, { alertsPhone: OWNER }));
    // Above Rs 100 again, then a message below: told what is left, once.
    await billing.grantCredits(shopId, 10_00n, 'More to try with');
    await charge(3);
    await dispatch(2);
    const low = ['credit_low', 'whatsapp', OWNER, { shop: 'Zari Fashions', balance: 'Rs 97.14' }];
    expect(await notices()).toEqual([low]);

    // A month on Starter ending in three days: its next is invoiced, and the shop told.
    const now = Date.now();
    await admin.query(
      `INSERT INTO billing.subscriptions
              (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'starter', 'monthly', $2, $3)`,
      [shopId, new Date(now - 27 * DAY), new Date(now + 3 * DAY)],
    );
    expect(await billing.sweep(new Date(now))).toMatchObject({ invoiced: 1 });
    await dispatch(2);
    const [renewal] = await billing.invoicesOf(shopId);
    const due = [
      'invoice_due',
      'whatsapp',
      OWNER,
      { shop: 'Zari Fashions', invoice: renewal!.name, plan: 'Starter', amount: 'Rs 2,499' },
    ];
    expect(await notices()).toEqual([low, due]);
    // Unpaid a week past its end: on Free, and told so.
    expect(await billing.sweep(new Date(now + 11 * DAY))).toMatchObject({ ended: 1 });
    await dispatch(2);
    const ended = ['plan_ended', 'whatsapp', OWNER, { shop: 'Zari Fashions' }];
    expect(await notices()).toEqual([low, due, ended]);

    // Hatti pays for them, never the shop's credit: they go even with it below nothing.
    await charge(21);
    expect(await wallet.balanceOf(shopId)).toBe(-4_50n);
    const paying = new MessagesSender({
      messages: new MessagesService(database, wallet),
      providers: { whatsapp: whatsapp(), sms: sms() },
      charges: wallet,
    });
    expect(await paying.sweep(soon())).toBe(3);
    expect(
      requests.map((request) => (request.body.template as { name: string }).name).sort(),
    ).toEqual(['hatti_credit_low', 'hatti_invoice_due', 'hatti_plan_ended']);
    expect(await wallet.balanceOf(shopId)).toBe(-4_50n);
    expect((await queued()).map((message) => message.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it("emails the shop's owner of its bills too, at the email they proved, in their own language (ADR-195)", async () => {
    const billing = new BillingService(database, new PublicSite('https://hatti.pk'));
    const [ownerId, EMAIL, OWNER] = [newId(), 'owner@zari.pk', '+923335550009'];
    await admin.query(
      `INSERT INTO identity.users (id, name, email, email_verified_at, language)
       VALUES ($1, 'Ayesha Khan', $2, now(), 'ur')`,
      [ownerId, EMAIL],
    );
    await admin.query(
      "INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')",
      [ownerId, shopId],
    );
    const told = async () =>
      (
        await admin.query<{ kind: string; channel: string; recipient: string; language: string }>(
          `SELECT kind, channel, recipient, language FROM messaging.messages
            WHERE shop_id = $1 ORDER BY created_at, id`,
          [shopId],
        )
      ).rows.map((message) => [message.kind, message.channel, message.recipient, message.language]);
    try {
      // No alerts number: the owner hears all the same, by email, in Urdu as they chose.
      const now = Date.now();
      await admin.query(
        `INSERT INTO billing.subscriptions
                (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'starter', 'monthly', $2, $3)`,
        [shopId, new Date(now - 27 * DAY), new Date(now + 3 * DAY)],
      );
      expect(await billing.sweep(new Date(now))).toMatchObject({ invoiced: 1 });
      await dispatch(2);
      expect(await told()).toEqual([['invoice_due', 'email', EMAIL, 'ur']]);
      const [renewal] = await billing.invoicesOf(shopId);
      expect((await queued())[0]!.variables).toEqual({
        shop: 'Zari Fashions',
        invoice: renewal!.name,
        plan: 'Starter',
        amount: 'Rs 2,499',
      });

      // Given a number too, both: the number in the shop's language, the email in theirs.
      unwrap(await new MessagingSettingsService(database).update(tenant, { alertsPhone: OWNER }));
      expect(await billing.sweep(new Date(now + 11 * DAY))).toMatchObject({ ended: 1 });
      await dispatch(2);
      expect((await told()).slice(1)).toEqual([
        ['plan_ended', 'whatsapp', OWNER, 'en'],
        ['plan_ended', 'email', EMAIL, 'ur'],
      ]);
      // Each goes by its own channel, the emails as they are written for the owner.
      const emailed: OutgoingMessage[] = [];
      const emails: MessageProvider = {
        name: 'emails',
        channel: 'email',
        send: async (message) => {
          emailed.push(message);
          return { ok: true, providerMessageId: `email-${message.id}` };
        },
      };
      expect(await sender({ whatsapp: whatsapp(), sms: sms(), email: emails }).sweep(soon())).toBe(
        3,
      );
      expect(emailed.map((message) => [message.kind, message.recipient, message.language])).toEqual(
        [
          ['invoice_due', EMAIL, 'ur'],
          ['plan_ended', EMAIL, 'ur'],
        ],
      );

      // Its email no longer proved: credit running low is told at the number alone.
      await admin.query('UPDATE identity.users SET email_verified_at = NULL WHERE id = $1', [
        ownerId,
      ]);
      await billing.grantCredits(shopId, 101_00n, 'To try messages with');
      await database.tenant(shopId, (tx) =>
        new MessageWallet(database).chargeIn(tx, shopId, newId(), {
          channel: 'whatsapp',
          category: 'utility',
          parts: 1,
        }),
      );
      await dispatch(2);
      expect((await told()).slice(3)).toEqual([['credit_low', 'whatsapp', OWNER, 'en']]);
    } finally {
      // The shop has one owner: the staff's own test gives it another.
      await admin.query('DELETE FROM identity.memberships WHERE user_id = $1', [ownerId]);
    }
  });

  it('tells customers of store credit given them, and a week before a credit of theirs expires (ADR-192)', async () => {
    const { customerId } = await placeOnline();
    const storeCredit = new StoreCreditService(database);
    const told = async () =>
      (await queued())
        .filter((message) => message.kind.startsWith('store_credit'))
        .map((message) => [message.kind, message.channel, message.recipient, message.variables]);
    const give = async (amount: string, days: number | null) =>
      unwrap(
        await storeCredit.credit(
          tenant,
          { customerId },
          {
            amount,
            currencyCode: 'PKR',
            expiresAt: days === null ? null : new Date(Date.now() + days * DAY),
          },
        ),
      ).transaction;

    // Each credit as it is given, with all they have then.
    const expiring = await give('1000', 5);
    await dispatch(2);
    await give('500', null);
    await dispatch(2);
    const given = [
      [
        'store_credit_given',
        'whatsapp',
        AYESHA,
        { shop: 'Zari Fashions', amount: 'Rs 1,000', balance: 'Rs 1,000' },
      ],
      [
        'store_credit_given',
        'whatsapp',
        AYESHA,
        { shop: 'Zari Fashions', amount: 'Rs 500', balance: 'Rs 1,500' },
      ],
    ];
    expect(await told()).toEqual(given);
    // Given and spent before the worker heard of it: nothing to tell.
    await give('200', 1);
    unwrap(await storeCredit.debit(tenant, { customerId }, { amount: '200', currencyCode: 'PKR' }));
    await dispatch(2);
    expect(await told()).toEqual(given);

    // The sweep finds the credit that expires within the week: its customer is told when.
    expect(await new StoreCreditExpiry(storeCredit).sweep()).toEqual({ expired: 0, reminded: 1 });
    await dispatch(2);
    expect(await told()).toEqual([
      ...given,
      [
        'store_credit_expiring',
        'whatsapp',
        AYESHA,
        {
          shop: 'Zari Fashions',
          amount: 'Rs 1,000',
          date: shopTime('Asia/Karachi', expiring.expiresAt!),
        },
      ],
    ]);
  });

  it('tells staff at their own numbers of an order given to them, and of a comment naming them (ADR-191)', async () => {
    const [ayeshaId, bilalId, sanaId] = [newId(), newId(), newId()];
    const [AYESHA_MALIK, BILAL] = ['+923211234567', '+923331234567'];
    // Sana signed up with her email; her number waits for its code.
    await admin.query(
      `INSERT INTO identity.users (id, name, email, phone_e164, phone_verified_at, language)
       VALUES ($1, 'Ayesha Malik', NULL, $4, now(), 'en'),
              ($2, 'Bilal Ahmed', NULL, $5, now(), 'ur'),
              ($3, 'Sana', 'sana@example.pk', '+923451234567', NULL, 'en')`,
      [ayeshaId, bilalId, sanaId, AYESHA_MALIK, BILAL],
    );
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role)
       VALUES ($1, $4, 'owner'), ($2, $4, 'packer'), ($3, $4, 'confirmation_agent')`,
      [ayeshaId, bilalId, sanaId, shopId],
    );
    const as = (userId: string, role: StaffRole): TenantContext => ({
      ...tenant,
      actor: { kind: 'staff', userId, sessionId: newId(), authenticatedAt: new Date(), role },
    });
    const give = (who: TenantContext, orderId: string, userId: string, name: string) =>
      orders().assign(
        who,
        orderId,
        { staffMemberId: userId, name },
        { fromOthers: who.actor.kind === 'app' },
      );
    const alerts = async () =>
      (await queued())
        .filter((message) => ['order_assigned', 'order_mentioned'].includes(message.kind))
        .map((message) => [message.kind, message.channel, message.recipient, message.variables]);
    const said = (order: { number: number }) => ({
      shop: 'Zari Fashions',
      order: `#${order.number}`,
    });
    const [first, second, third] = [await placeOnline(), await placeOnline(), await placeOnline()];

    // An app gives Bilal the first; he takes the second himself, which needs no telling.
    unwrap(await give(tenant, first.id, bilalId, 'Bilal Ahmed'));
    unwrap(await give(as(bilalId, 'packer'), second.id, bilalId, 'Bilal Ahmed'));
    // The third goes to him and at once to Ayesha: she is told, not he.
    unwrap(await give(tenant, third.id, bilalId, 'Bilal Ahmed'));
    unwrap(await give(tenant, third.id, ayeshaId, 'Ayesha Malik'));
    // Sana proved no number: nothing.
    unwrap(await give(tenant, second.id, sanaId, 'Sana'));
    await dispatch(2);
    const assigned = [
      ['order_assigned', 'whatsapp', BILAL, said(first)],
      ['order_assigned', 'whatsapp', AYESHA_MALIK, said(third)],
    ];
    expect(await alerts()).toEqual(assigned);
    // Each in their own language, whatever the shop's: Bilal reads Urdu (ADR-194).
    expect(
      (
        await admin.query(
          `SELECT recipient, language FROM messaging.messages
            WHERE kind = 'order_assigned' ORDER BY created_at, id`,
        )
      ).rows,
    ).toEqual([
      { recipient: BILAL, language: 'ur' },
      { recipient: AYESHA_MALIK, language: 'en' },
    ]);

    // Ayesha names Bilal, Sana and herself: Bilal is told; Sana has no number, and she wrote it.
    const comments = new OrderCommentService(database);
    const note = unwrap(
      await comments.create(
        as(ayeshaId, 'owner'),
        first.id,
        '@bilal ahmed, @Sana and @Ayesha Malik: she asked us to call after 5',
      ),
    );
    await dispatch(2);
    const mentioned = ['order_mentioned', 'whatsapp', BILAL, said(first)];
    expect(await alerts()).toEqual([...assigned, mentioned]);
    // Changed and naming him still: once a comment. An app's naming Ayesha tells her.
    unwrap(await comments.update(as(ayeshaId, 'owner'), note.id, '@Bilal Ahmed: after 6 now'));
    unwrap(await comments.create(tenant, second.id, 'The courier asked for @Ayesha Malik'));
    await dispatch(2);
    expect(await alerts()).toEqual([
      ...assigned,
      mentioned,
      ['order_mentioned', 'whatsapp', AYESHA_MALIK, said(second)],
    ]);

    // Turned off, as the shop's other alerts are.
    unwrap(
      await new MessagingSettingsService(database).update(tenant, {
        disabled: ['order_mentioned'],
      }),
    );
    unwrap(await comments.create(tenant, third.id, '@Bilal Ahmed, packed?'));
    await dispatch();
    expect(await alerts()).toHaveLength(4);
  });

  it("tells staff a customer sent the receipt of their transfer: its order's own member, else its owners and managers (ADR-247)", async () => {
    // The shop's staff now: an owner and a manager with numbers, one without, a packer and an
    // accountant.
    const [hina, omar, faraz, danish, zara] = [newId(), newId(), newId(), newId(), newId()];
    const [HINA, OMAR, DANISH, ZARA] = [
      '+923451110001',
      '+923451110002',
      '+923451110003',
      '+923451110004',
    ];
    await admin.query('DELETE FROM identity.memberships WHERE shop_id = $1', [shopId]);
    await admin.query(
      `INSERT INTO identity.users (id, name, email, phone_e164, phone_verified_at, language)
       VALUES ($1, 'Hina Butt', NULL, $6, now(), 'ur'),
              ($2, 'Omar Sheikh', NULL, $7, now(), 'en'),
              ($3, 'Faraz', 'faraz@example.pk', '+923451110005', NULL, 'en'),
              ($4, 'Danish', NULL, $8, now(), 'en'),
              ($5, 'Zara', NULL, $9, now(), 'en')`,
      [hina, omar, faraz, danish, zara, HINA, OMAR, DANISH, ZARA],
    );
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role)
       VALUES ($1, $6, 'owner'), ($2, $6, 'manager'), ($3, $6, 'manager'), ($4, $6, 'packer'),
              ($5, $6, 'accountant')`,
      [hina, omar, faraz, danish, zara, shopId],
    );
    const receipts = async () =>
      (await queued())
        .filter((message) => message.kind === 'order_receipt_sent')
        .map((message) => [message.recipient, message.variables]);
    // As the customer's link takes a receipt: the order says it changed so (ADR-080).
    const receiptSent = (order: { id: string; version: number }) =>
      database.tenant(shopId, (tx) =>
        appendEvent(tx, shopId, {
          type: 'order.updated',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            changed: ['transferReceipt'],
            stage: 'awaiting_payment',
            version: order.version,
          },
        }),
      );
    const waiting = await placeOnline({ paymentMethod: 'bank_transfer' });
    const said = { shop: 'Zari Fashions', order: `#${waiting.number}` };

    // No one has the order: its owners and managers with numbers are told.
    await receiptSent(waiting);
    await dispatch(2);
    expect(await receipts()).toEqual([
      [HINA, said],
      [OMAR, said],
    ]);
    // Given to Danish: the next receipt is his alone.
    unwrap(
      await orders().assign(
        tenant,
        waiting.id,
        { staffMemberId: danish, name: 'Danish' },
        { fromOthers: true },
      ),
    );
    await receiptSent(waiting);
    await dispatch(2);
    expect(await receipts()).toEqual([
      [HINA, said],
      [OMAR, said],
      [DANISH, said],
    ]);

    // Marked paid before the worker heard of the receipt: nothing left to look for.
    await receiptSent(waiting);
    unwrap(await orders().markAsPaid(tenant, waiting.id));
    await dispatch(2);
    expect(await receipts()).toHaveLength(3);
    // Other changes to an order tell no one.
    const other = await placeOnline({ paymentMethod: 'bank_transfer' });
    await database.tenant(shopId, (tx) =>
      appendEvent(tx, shopId, {
        type: 'order.updated',
        aggregateType: 'order',
        aggregateId: other.id,
        payload: { changed: ['note'], stage: 'awaiting_payment', version: other.version },
      }),
    );
    await dispatch(2);
    expect(await receipts()).toHaveLength(3);
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

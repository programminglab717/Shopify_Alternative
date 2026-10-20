import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { LowStockAlert, LowStockService } from '@hatti/inventory/public';
import { LogisticsEvents } from '@hatti/logistics/public';
import {
  MessagingEvents,
  MessagesService,
  PushService,
  generateVapidKeys,
  type PushOutcome,
  type WebPushSender,
} from '@hatti/messaging/public';
import { OrderEvents } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LowStockAlerts } from './low-stock-alerts.js';
import { PushNotices } from './push-notices.js';

const server = testDatabaseServer();

/** A push service, each push kept. */
class FakeSender {
  readonly publicKey = generateVapidKeys().publicKey;
  readonly sent: { endpoint: string; message: Record<string, string> }[] = [];

  send(subscription: { endpoint: string }, message: object): Promise<PushOutcome> {
    this.sent.push({ endpoint: subscription.endpoint, message: message as Record<string, string> });
    return Promise.resolve('sent');
  }
}

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

describe.skipIf(!server)("The shop's news pushed to its staff (APP-03, ADR-506)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let sender: FakeSender;
  let push: PushService;
  const shopId = newId();
  const [owner, agent, accountant, packer] = [newId(), newId(), newId(), newId()];
  const shop = toPublicId('shop', shopId);

  const event = (type: string, aggregateId: string, payload: Record<string, unknown>) => ({
    id: newId(),
    type,
    shopId,
    aggregateType: 'order',
    aggregateId,
    payload,
    occurredAt: new Date().toISOString(),
  });
  const created = (orderId: string, extra: Record<string, unknown> = {}) =>
    event(OrderEvents.OrderCreated, orderId, {
      number: 1001,
      stage: 'needs_confirmation',
      version: 1,
      customerId: newId(),
      source: 'online_store',
      paymentMethod: 'cash_on_delivery',
      total: '450000',
      currency: 'PKR',
      riskLevel: 'low',
      ...extra,
    });
  const told = () =>
    sender.sent
      .map((each) => ({
        endpoint: each.endpoint,
        title: each.message.title,
        url: each.message.url,
      }))
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'push-notices-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shopId,
    ]);
    await admin.query(
      `INSERT INTO identity.users (id, name, email, language)
       VALUES ($1, 'Ayesha', 'ayesha@zari.pk', 'en'), ($2, 'Bilal', 'bilal@zari.pk', 'ur'),
              ($3, 'Sana', 'sana@zari.pk', 'en'), ($4, 'Omar', 'omar@zari.pk', 'en')`,
      [owner, agent, accountant, packer],
    );
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role)
       VALUES ($1, $5, 'owner'), ($2, $5, 'confirmation_agent'), ($3, $5, 'accountant'),
              ($4, $5, 'packer')`,
      [owner, agent, accountant, packer, shopId],
    );
    const all = '{new_order,needs_review,cash_remitted,low_stock,contact_message}';
    await admin.query(
      `INSERT INTO messaging.push_subscriptions (shop_id, user_id, endpoint, p256dh, auth, kinds)
       VALUES ($1, $2, $6, $10, $11, $12), ($1, $3, $7, $10, $11, $12),
              ($1, $4, $8, $10, $11, $12), ($1, $5, $9, $10, $11, $12)`,
      [
        shopId,
        owner,
        agent,
        accountant,
        packer,
        endpoint('owner'),
        endpoint('agent'),
        endpoint('accountant'),
        endpoint('packer'),
        'B'.repeat(87),
        'a'.repeat(22),
        all,
      ],
    );
  });

  beforeEach(() => {
    sender = new FakeSender();
    push = new PushService(database, sender as unknown as WebPushSender);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('pushes a new order to who confirms orders, in their language, once', async () => {
    const notices = new PushNotices(database, push);
    const orderId = newId();
    await notices.handle(created(orderId));
    await notices.handle(created(orderId));
    const url = `/${shop}/orders/${toPublicId('order', orderId)}`;
    expect(told()).toEqual([
      { endpoint: endpoint('agent'), title: 'Zari: نیا آرڈر #1001', url },
      { endpoint: endpoint('owner'), title: 'Zari: new order #1001', url },
    ]);
    expect(sender.sent.find((each) => each.endpoint === endpoint('owner'))!.message.body).toBe(
      'Rs 4,500, cash on delivery.',
    );
  });

  it('pushes an order held for review as one to review, and nothing of a split', async () => {
    const notices = new PushNotices(database, push);
    const held = newId();
    await notices.handle(created(held, { number: 1002, stage: 'needs_review', riskLevel: 'high' }));
    await notices.handle(created(newId(), { number: 1003, splitFromId: held }));
    expect(told().map((each) => each.title)).toEqual([
      'Zari: آرڈر #1002 جانچنا ہے',
      'Zari: order #1002 to review',
    ]);
  });

  it("pushes a courier's statement to who keeps the money", async () => {
    const notices = new PushNotices(database, push);
    const remittanceId = newId();
    await notices.handle(
      event(LogisticsEvents.CodRemittanceImported, remittanceId, {
        courier: 'PostEx',
        reference: 'PX-88',
        lineCount: 12,
        collected: '5400000',
        received: '5200000',
      }),
    );
    const url = `/${shop}/cash/${toPublicId('codRemittance', remittanceId)}`;
    expect(told()).toEqual([
      { endpoint: endpoint('accountant'), title: 'Zari: PostEx remitted Rs 52,000', url },
      { endpoint: endpoint('owner'), title: 'Zari: PostEx remitted Rs 52,000', url },
    ]);
  });

  it('pushes a message through the contact form to who answers customers, saying not what (ADR-591)', async () => {
    const notices = new PushNotices(database, push);
    const messageId = newId();
    await notices.handle(
      event(MessagingEvents.ContactMessageReceived, messageId, { language: 'en' }),
    );
    await notices.handle(
      event(MessagingEvents.ContactMessageReceived, messageId, { language: 'en' }),
    );
    const url = `/${shop}/inbox?tab=form`;
    expect(told()).toEqual([
      { endpoint: endpoint('agent'), title: 'Zari: رابطہ صفحے سے پیغام', url },
      { endpoint: endpoint('owner'), title: 'Zari: a message from your contact page', url },
    ]);
    expect(sender.sent.find((each) => each.endpoint === endpoint('owner'))!.message.body).toBe(
      'A shopper wrote to you. Read it in the inbox and answer them.',
    );
  });

  it('pushes low stock to owners and managers with its spell, without an alerts number', async () => {
    const productId = newId();
    const alert: LowStockAlert = {
      variantId: newId(),
      productId,
      productTitle: 'Lawn suit',
      variantTitle: 'Medium',
      sku: null,
      available: 2,
      state: 'low',
      threshold: 3,
      since: new Date('2026-10-17T05:00:00Z'),
    };
    const lowStock = { alertIn: () => Promise.resolve(alert) } as unknown as LowStockService;
    const alerts = new LowStockAlerts(database, lowStock, new MessagesService(database), push);
    const level = event('inventory_level.updated', newId(), { inventoryItemId: alert.variantId });
    await alerts.handle(level);
    await alerts.handle(level);
    expect(told()).toEqual([
      {
        endpoint: endpoint('owner'),
        title: 'Zari: Lawn suit (Medium) is running low',
        url: `/${shop}/products/${toPublicId('product', productId)}`,
      },
    ]);
  });

  it('does nothing where Hatti has no VAPID keys', async () => {
    const off = new PushService(database, null);
    await new PushNotices(database, off).handle(created(newId()));
    expect(sender.sent).toEqual([]);
  });
});

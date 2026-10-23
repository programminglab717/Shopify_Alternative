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
import { OnlineStoreEvents } from '@hatti/online-store/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LowStockAlerts } from './low-stock-alerts.js';
import { OverdueConversationPushes, PushNotices } from './push-notices.js';

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
    database = new Database({
      appUrl: testDb.appUrl,
      // The sweep of conversations waiting too long finds its shops with the system role.
      systemUrl: testDb.systemUrl,
      applicationName: 'push-notices-test',
    });
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
    const all = '{new_order,needs_review,cash_remitted,low_stock,contact_message,comment_pending}';
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

  it('pushes a comment held for approval to who writes the blogs, and nothing else (ADR-619)', async () => {
    const notices = new PushNotices(database, push);
    const articleId = newId();
    const commentId = newId();
    for (const status of ['published', 'spam']) {
      await notices.handle(
        event(OnlineStoreEvents.CommentCreated, newId(), { articleId, status, shown: false }),
      );
    }
    expect(told()).toEqual([]);
    const held = event(OnlineStoreEvents.CommentCreated, commentId, {
      articleId,
      status: 'pending',
      shown: false,
    });
    await notices.handle(held);
    await notices.handle(held);
    // The owner alone of these writes the blogs.
    expect(told()).toEqual([
      {
        endpoint: endpoint('owner'),
        title: 'Zari: a comment to approve',
        url: `/${shop}/online-store/articles/${toPublicId('article', articleId)}`,
      },
    ]);
  });

  it("pushes who confirms orders of a refused parcel's customer's orders yet to ship, each once (ADR-672)", async () => {
    await admin.query(
      `UPDATE messaging.push_subscriptions SET kinds = kinds || '{customer_refused}'
        WHERE shop_id = $1`,
      [shopId],
    );
    const refusedId = newId();
    const [toPack, toBook] = [newId(), newId()];
    const asked: string[] = [];
    const notices = new PushNotices(database, push, (_tx, _shop, orderId) => {
      asked.push(orderId);
      return Promise.resolve({
        refused: { id: refusedId, number: 1001 },
        toShip: [
          { id: toPack, number: 1004 },
          { id: toBook, number: 1005 },
        ],
      });
    });
    const parcel = newId();
    const updated = (payload: Record<string, unknown>) =>
      event(OrderEvents.FulfillmentUpdated, parcel, {
        orderId: refusedId,
        version: 2,
        orderStage: 'returning',
        orderVersion: 5,
        ...payload,
      });
    // Its tracking changing, or its being delivered, is nothing to tell.
    await notices.handle(updated({ status: 'returning', changed: ['tracking'] }));
    await notices.handle(updated({ status: 'delivered', changed: ['status'] }));
    expect([asked, sender.sent]).toEqual([[], []]);
    await notices.handle(updated({ status: 'returning', changed: ['status'] }));
    await notices.handle(updated({ status: 'returning', changed: ['status'] }));
    const order = (id: string) => `/${shop}/orders/${toPublicId('order', id)}`;
    expect(told()).toEqual([
      {
        endpoint: endpoint('agent'),
        title: 'Zari: #1004 کے خریدار نے پارسل واپس کر دیا',
        url: order(toPack),
      },
      {
        endpoint: endpoint('agent'),
        title: 'Zari: #1005 کے خریدار نے پارسل واپس کر دیا',
        url: order(toBook),
      },
      {
        endpoint: endpoint('owner'),
        title: "Zari: #1004's customer refused a parcel",
        url: order(toPack),
      },
      {
        endpoint: endpoint('owner'),
        title: "Zari: #1005's customer refused a parcel",
        url: order(toBook),
      },
    ]);
    expect(
      sender.sent.find(
        (each) => each.endpoint === endpoint('owner') && each.message.url === order(toPack),
      )!.message.body,
    ).toBe('Their parcel for #1001 is coming back. Call them before #1004 ships.');
    expect(asked).toEqual([refusedId, refusedId]);
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

  it('pushes a customer who began waiting on WhatsApp to whom it is given, else all who answer, and a conversation given to its member (ADR-761)', async () => {
    await admin.query(
      `UPDATE messaging.push_subscriptions
          SET kinds = kinds || '{conversation_message,conversation_assigned}'::text[]`,
    );
    const notices = new PushNotices(database, push);
    const conversationId = newId();
    const url = `/${shop}/inbox/${toPublicId('conversation', conversationId)}`;
    const wrote = (payload: Record<string, unknown>) =>
      notices.handle(
        event(MessagingEvents.ConversationMessageReceived, conversationId, {
          messageId: newId(),
          at: new Date().toISOString(),
          assigneeId: null,
          ...payload,
        }),
      );
    await wrote({ startedWaiting: true });
    expect(told()).toEqual([
      { endpoint: endpoint('agent'), title: 'Zari: واٹس ایپ پر گاہک کا پیغام', url },
      { endpoint: endpoint('owner'), title: 'Zari: a customer wrote on WhatsApp', url },
    ]);
    // Writing again while waiting is no news; an event of before says nothing of waiting.
    await wrote({ startedWaiting: false });
    await wrote({ startedWaiting: undefined });
    expect(sender.sent).toHaveLength(2);
    // Given to the agent, it is theirs alone.
    sender.sent.length = 0;
    await wrote({ startedWaiting: true, assigneeId: agent });
    expect(told().map((each) => each.endpoint)).toEqual([endpoint('agent')]);

    sender.sent.length = 0;
    const given = (assigneeId: string | null, assignedBy: string | null) =>
      notices.handle(
        event(MessagingEvents.ConversationAssigned, conversationId, { assigneeId, assignedBy }),
      );
    // Taken for oneself, or given back: no one told.
    await given(agent, agent);
    await given(null, owner);
    expect(sender.sent).toEqual([]);
    await given(agent, owner);
    expect(told()).toEqual([
      { endpoint: endpoint('agent'), title: 'Zari: ایک بات چیت آپ کے سپرد', url },
    ]);
  });

  it("pushes a customer waiting past the shop's time to answer, to whom it is given or all who answer, once a wait (ADR-762)", async () => {
    await admin.query(
      `UPDATE messaging.push_subscriptions SET kinds = kinds || '{conversation_overdue}'::text[]`,
    );
    const sweep = new OverdueConversationPushes(database, push);
    const at = new Date();
    const ago = (minutes: number) => new Date(at.getTime() - minutes * 60_000).toISOString();
    // No target, no one late.
    const conversation = async (phone: string, waited: number, assignee: string | null) => {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO messaging.conversations
                (shop_id, customer_phone, last_message_at, last_inbound_at, waiting_since,
                 assignee_id, assigned_at)
         VALUES ($1, $2, $3, $3, $3, $4::uuid, CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [shopId, phone, ago(waited), assignee],
      );
      return rows[0]!.id;
    };
    const late = await conversation('+923001110001', 45, null);
    await conversation('+923001110002', 10, null);
    const theirs = await conversation('+923001110003', 50, agent);
    // Past WhatsApp's day: no longer the shop's to answer freely.
    await conversation('+923001110004', 2 * 24 * 60, null);
    expect(await sweep.sweep(at)).toBe(0);

    await admin.query(
      `INSERT INTO messaging.settings (shop_id, reply_target_minutes) VALUES ($1, 30)
           ON CONFLICT (shop_id) DO UPDATE SET reply_target_minutes = 30`,
      [shopId],
    );
    expect(await sweep.sweep(at)).toBe(2);
    const url = (id: string) => `/${shop}/inbox/${toPublicId('conversation', id)}`;
    expect(told()).toEqual([
      { endpoint: endpoint('agent'), title: 'Zari: گاہک بہت دیر سے انتظار میں', url: url(theirs) },
      { endpoint: endpoint('agent'), title: 'Zari: گاہک بہت دیر سے انتظار میں', url: url(late) },
      {
        endpoint: endpoint('owner'),
        title: 'Zari: a customer has waited too long',
        url: url(late),
      },
    ]);
    // The next sweep tells no one again; a new wait, after an answer, is told anew.
    await sweep.sweep(at);
    expect(sender.sent).toHaveLength(3);
    await admin.query('UPDATE messaging.conversations SET waiting_since = $2 WHERE id = $1', [
      theirs,
      ago(40),
    ]);
    await sweep.sweep(at);
    expect(sender.sent).toHaveLength(4);
    await admin.query('DELETE FROM messaging.settings WHERE shop_id = $1', [shopId]);
  });

  it('does nothing where Hatti has no VAPID keys', async () => {
    const off = new PushService(database, null);
    await new PushNotices(database, off).handle(created(newId()));
    expect(sender.sent).toEqual([]);
  });
});

import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationsService, claimCartIn } from './conversations.service.js';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import { MessagingEvents } from './events.js';
import { WHATSAPP_CLOUD } from './providers.js';
import type { InboundMessage } from './whatsapp-webhook.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_conversations']),
  };
}

const AYESHA = '+923001234567';
const BILAL = '+923217654321';
const SHARED = '100000000000001';
const OWN = '200000000000002';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from: AYESHA,
    text: 'Is the lawn suit in medium?',
    replyTo: null,
    payload: null,
    at: new Date('2026-10-17T09:00:00Z'),
    id: `wamid.${newId()}`,
    to: SHARED,
    mediaKind: null,
    ...overrides,
  };
}

describe.skipIf(!server)("The inbox: customers' WhatsApp messages (MSG-05, ADR-545)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let inbox: ConversationsService;
  const a = tenant(newId());
  const b = tenant(newId());

  /** A message the shop sent `to` on WhatsApp, with WhatsApp's ID for it. */
  async function sent(shopId: string, to: string, providerId: string, minutesAgo = 10) {
    await admin.query(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
               provider_message_id, sent_at, created_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', $3, 'sent', $4, $5, now(),
               now() - make_interval(mins => $6))`,
      [shopId, to, `test:${newId()}`, WHATSAPP_CLOUD, providerId, minutesAgo],
    );
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'conversations-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    inbox = new ConversationsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM messaging.conversations; DELETE FROM messaging.messages; ' +
        'DELETE FROM messaging.whatsapp_accounts; DELETE FROM platform.outbox_events',
    );
  });

  it("keeps a message to the shop's own number as that shop's", async () => {
    await admin.query(
      `INSERT INTO messaging.whatsapp_accounts
              (shop_id, business_account_id, phone_number_id, display_phone_number,
               verified_name, access_token, pin)
       VALUES ($1, '300', $2, '+92 300 0000000', 'B', 'sealed', 'sealed')`,
      [b.shopId, OWN],
    );
    // A had written to Ayesha last, from the shared number: what she writes to B's is B's.
    await sent(a.shopId, AYESHA, 'wamid.a-1');
    expect(await inbox.recordInbound(inbound({ to: OWN }))).toBe(b.shopId);

    const { items } = await inbox.list(b, { first: 10, after: null });
    expect(items).toEqual([
      expect.objectContaining({
        customerPhone: AYESHA,
        viaOwnNumber: true,
        status: 'open',
        unread: 1,
        lastMessageAt: new Date('2026-10-17T09:00:00Z'),
        lastInboundAt: new Date('2026-10-17T09:00:00Z'),
        lastMessage: expect.objectContaining({
          direction: 'inbound',
          body: 'Is the lawn suit in medium?',
          mediaKind: null,
        }),
      }),
    ]);
    expect((await inbox.list(a, { first: 10, after: null })).items).toEqual([]);
  });

  it('keeps one to the shared number as the shop whose message it answers, else the last to write', async () => {
    await sent(a.shopId, AYESHA, 'wamid.a-1', 30);
    await sent(b.shopId, AYESHA, 'wamid.b-1', 5);
    // She answers A's older message: A's, though B wrote to her since.
    expect(await inbox.recordInbound(inbound({ replyTo: 'wamid.a-1' }))).toBe(a.shopId);
    // She writes without answering: the last shop to write to her, B.
    expect(await inbox.recordInbound(inbound({ text: 'Hello?' }))).toBe(b.shopId);
    // A number no shop wrote to is no one's.
    expect(await inbox.recordInbound(inbound({ from: BILAL }))).toBeNull();
    // Nor is a message with nothing in it, as a reaction.
    expect(await inbox.recordInbound(inbound({ text: null }))).toBeNull();

    const [ofA] = (await inbox.list(a, { first: 10, after: null })).items;
    expect(ofA).toMatchObject({ viaOwnNumber: false, unread: 1 });
    const [ofB] = (await inbox.list(b, { first: 10, after: null })).items;
    expect(ofB!.lastMessage!.body).toBe('Hello?');
    const { rows } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM messaging.conversation_messages',
    );
    expect(rows[0]!.count).toBe(2);
  });

  it("keeps a cart from the shop's WhatsApp catalogue, to answer once (CH-02, ADR-856)", async () => {
    await sent(b.shopId, BILAL, 'wamid.b-cart');
    const cart = inbound({
      from: BILAL,
      text: null,
      mediaKind: 'order',
      cart: [{ variantId: 'v-1', quantity: 2 }],
    });
    expect(await inbox.recordInbound(cart)).toBe(b.shopId);
    const { rows } = await admin.query<{ id: string; cart: unknown }>(
      `SELECT id, cart FROM messaging.conversation_messages WHERE shop_id = $1 AND media_kind = 'order'`,
      [b.shopId],
    );
    expect(rows[0]!.cart).toEqual([{ variantId: 'v-1', quantity: 2 }]);
    const claim = () => db.tenant(b.shopId, (tx) => claimCartIn(tx, b.shopId, rows[0]!.id));
    expect(await claim()).toEqual({
      conversationId: expect.any(String),
      customerPhone: BILAL,
      items: [{ variantId: 'v-1', quantity: 2 }],
    });
    expect(await claim()).toBeNull();
  });

  it('keeps a message once however often the webhook names it, a photo as its kind', async () => {
    await sent(a.shopId, AYESHA, 'wamid.a-1');
    const photo = inbound({ text: null, mediaKind: 'image' });
    expect(await inbox.recordInbound(photo)).toBe(a.shopId);
    expect(await inbox.recordInbound(photo)).toBe(a.shopId);

    const [conversation] = (await inbox.list(a, { first: 10, after: null })).items;
    expect(conversation).toMatchObject({
      unread: 1,
      lastMessage: { direction: 'inbound', body: null, mediaKind: 'image' },
    });
    const { rows } = await admin.query<{ aggregate_id: string }>(
      'SELECT aggregate_id FROM platform.outbox_events WHERE event_type = $1',
      [MessagingEvents.ConversationMessageReceived],
    );
    expect(rows).toEqual([{ aggregate_id: conversation!.id }]);
  });

  it('lists the latest written first, a page at a time, the unread or closed alone', async () => {
    await sent(a.shopId, AYESHA, 'wamid.a-1');
    await sent(a.shopId, BILAL, 'wamid.a-2');
    await inbox.recordInbound(inbound({ at: new Date('2026-10-17T08:00:00Z') }));
    await inbox.recordInbound(inbound({ from: BILAL, at: new Date('2026-10-17T10:00:00Z') }));
    // A late delivery of an older message leaves the conversation's time as it was.
    await inbox.recordInbound(inbound({ text: 'Older', at: new Date('2026-10-17T07:00:00Z') }));

    const first = await inbox.list(a, { first: 1, after: null });
    expect(first.items.map((c) => c.customerPhone)).toEqual([BILAL]);
    expect(first.hasNextPage).toBe(true);
    const last = first.items[0]!;
    const second = await inbox.list(a, {
      first: 1,
      after: { id: last.id, lastMessageAt: last.lastMessageAtExactly },
    });
    expect(second.items.map((c) => c.customerPhone)).toEqual([AYESHA]);
    expect(second.items[0]!.lastMessageAt).toEqual(new Date('2026-10-17T08:00:00Z'));
    expect(second.items[0]!.unread).toBe(2);
    expect(second.hasNextPage).toBe(false);

    // Her messages, the latest first, a page at a time.
    const ayesha = second.items[0]!;
    const page = await inbox.messages(a, ayesha.id, { first: 1, before: null });
    expect(page.items.map((m) => m.body)).toEqual(['Is the lawn suit in medium?']);
    expect(page.hasNextPage).toBe(true);
    const older = await inbox.messages(a, ayesha.id, { first: 5, before: page.items[0]!.id });
    expect(older.items.map((m) => m.body)).toEqual(['Older']);
    expect(older.hasNextPage).toBe(false);
    expect((await inbox.messages(b, ayesha.id, { first: 5, before: null })).items).toEqual([]);

    expect(await inbox.unreadCount(a)).toBe(2);
    expect(await inbox.markRead(a, ayesha.id)).toMatchObject({ unread: 0 });
    expect(await inbox.unreadCount(a)).toBe(1);
    expect(
      (await inbox.list(a, { first: 10, after: null, unread: true })).items.map(
        (c) => c.customerPhone,
      ),
    ).toEqual([BILAL]);

    // Closing reads it; writing again opens it, unread.
    const bilal = first.items[0]!;
    expect(await inbox.setStatus(a, bilal.id, 'closed')).toMatchObject({
      status: 'closed',
      unread: 0,
    });
    expect(await inbox.unreadCount(a)).toBe(0);
    expect(
      (await inbox.list(a, { first: 10, after: null, status: 'closed' })).items.map((c) => c.id),
    ).toEqual([bilal.id]);
    await inbox.recordInbound(inbound({ from: BILAL, at: new Date('2026-10-17T11:00:00Z') }));
    expect(await inbox.get(a, bilal.id)).toMatchObject({ status: 'open', unread: 1 });

    // Another shop's are not found.
    expect(await inbox.get(b, bilal.id)).toBeNull();
    expect(await inbox.markRead(b, bilal.id)).toBeNull();
    expect(await inbox.setStatus(b, bilal.id, 'closed')).toBeNull();
    expect(await inbox.get(a, bilal.id)).toMatchObject({ status: 'open', unread: 1 });
  });

  it("goes with an erased customer's numbers, and is in their own file", async () => {
    await sent(a.shopId, AYESHA, 'wamid.a-1');
    await sent(a.shopId, BILAL, 'wamid.a-2');
    await inbox.recordInbound(inbound());
    await inbox.recordInbound(inbound({ text: null, mediaKind: 'audio' }));
    await inbox.recordInbound(inbound({ from: BILAL }));
    const customer = { id: newId(), phones: [AYESHA], email: null } as never;

    const file = await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.export(tx, a.shopId, customer),
    );
    expect((file as { conversationMessages: unknown[] }).conversationMessages).toEqual([
      expect.objectContaining({
        number: AYESHA,
        direction: 'inbound',
        said: 'Is the lawn suit in medium?',
        held: null,
      }),
      expect.objectContaining({ number: AYESHA, direction: 'inbound', said: null, held: 'audio' }),
    ]);

    await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.erase(tx, a.shopId, customer, 'system'),
    );
    const { rows } = await admin.query<{ customer_phone: string }>(
      'SELECT customer_phone FROM messaging.conversations',
    );
    expect(rows).toEqual([{ customer_phone: BILAL }]);
    const messages = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM messaging.conversation_messages',
    );
    expect(messages.rows[0]!.count).toBe(1);
  });
});

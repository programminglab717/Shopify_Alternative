import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsService } from './conversations.service.js';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import { MessagingEvents } from './events.js';
import { WebChatService, webChatIn } from './web-chat.service.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      role: 'owner',
      authenticatedAt: new Date(),
    },
    scopes: new Set(['write_settings', 'write_conversations']),
  };
}

function unwrap<T>(result: MutationResult<T> | null): T {
  if (!result?.ok) throw new Error(`Expected success, got ${JSON.stringify(result)}`);
  return result.value;
}

const errorsOf = (result: MutationResult<unknown> | null) =>
  result && !result.ok
    ? result.errors.map((error) => `${error.field.join('.')}: ${error.message}`)
    : result;

const AT = new Date('2026-10-27T09:00:00Z');
const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

describe.skipIf(!server)("The chat on the shop's online store (MSG-10, ADR-810)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let chat: WebChatService;
  let inbox: ConversationsService;
  const a = tenant(newId());

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'web-chat-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [a.shopId]);
    chat = new WebChatService(db);
    inbox = new ConversationsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is off until the shop turns it on, its greeting checked, audited and published', async () => {
    expect(await chat.settings(a)).toEqual({ enabled: false, greeting: null, updatedAt: null });
    const first = { name: 'Ayesha', phone: '0300 1234567', body: 'Salam' };
    // Off: no chat to start.
    expect(await chat.start(a.shopId, first, AT)).toBeNull();
    expect(errorsOf(await chat.update(a, { greeting: 'x'.repeat(201) }))).toEqual([
      'input.greeting: Greet shoppers in 200 characters at most',
    ]);
    expect(
      unwrap(await chat.update(a, { enabled: true, greeting: '  Ask us anything  ' })),
    ).toMatchObject({ enabled: true, greeting: 'Ask us anything' });
    expect(await db.tenant(a.shopId, (tx) => webChatIn(tx, a.shopId))).toEqual({
      greeting: 'Ask us anything',
    });
    // Blank: Hatti's words.
    expect(unwrap(await chat.update(a, { greeting: ' ' })).greeting).toBeNull();
    const { rows: events } = await admin.query(
      `SELECT payload ->> 'enabled' AS enabled FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = $2`,
      [a.shopId, MessagingEvents.WebChatUpdated],
    );
    expect(events).toEqual([{ enabled: 'true' }, { enabled: 'true' }]);
    const { rows: audit } = await admin.query(
      `SELECT 1 FROM platform.audit_log WHERE shop_id = $1 AND action = $2`,
      [a.shopId, MessagingEvents.WebChatUpdated],
    );
    expect(audit).toHaveLength(2);
  });

  it("starts a chat with the shopper's name and number, kept in the inbox to answer", async () => {
    expect(errorsOf(await chat.start(a.shopId, { name: ' ', phone: '12', body: '' }, AT))).toEqual([
      'name: Say your name',
      'phone: Give a Pakistani mobile number, like 0300 1234567',
      'body: Write your message',
    ]);
    const started = unwrap(
      await chat.start(
        a.shopId,
        { name: 'Ayesha Khan', phone: '0300 1234567', body: 'Is the lawn suit in medium?' },
        AT,
      ),
    );
    expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.messages).toEqual([
      { id: expect.any(String), direction: 'inbound', body: 'Is the lawn suit in medium?', at: AT },
    ]);
    const { items } = await inbox.list(a, { first: 10, after: null });
    expect(items).toEqual([
      expect.objectContaining({
        channel: 'web',
        customerPhone: '+923001234567',
        customerName: 'Ayesha Khan',
        status: 'open',
        unread: 1,
        waitingSince: AT,
      }),
    ]);
    const { rows } = await admin.query(
      `SELECT 1 FROM platform.outbox_events WHERE shop_id = $1 AND event_type = $2`,
      [a.shopId, MessagingEvents.ConversationMessageReceived],
    );
    expect(rows).toHaveLength(1);

    // Answered from the inbox at any time: kept for the chat, read once the shopper's chat
    // reads it.
    const id = items[0]!.id;
    const reply = unwrap(await inbox.reply(a, id, 'Yes, in stock', later(60 * 30)));
    expect(reply.message).toMatchObject({ direction: 'outbound', status: 'sent' });
    expect(reply.conversation).toMatchObject({ unread: 0, waitingSince: null });
    const read = (await chat.read(a.shopId, started.token, later(60 * 30 + 1)))!;
    expect(read.map((message) => [message.direction, message.body])).toEqual([
      ['inbound', 'Is the lawn suit in medium?'],
      ['outbound', 'Yes, in stock'],
    ]);
    const { rows: statuses } = await admin.query(
      `SELECT status FROM messaging.conversation_messages WHERE id = $1`,
      [reply.message.id],
    );
    expect(statuses).toEqual([{ status: 'read' }]);

    // Written in again: the same conversation, waiting again.
    const after = unwrap(
      await chat.write(a.shopId, started.token, { body: 'Thanks!' }, later(60 * 31)),
    );
    expect(after.map((message) => message.body)).toEqual([
      'Is the lawn suit in medium?',
      'Yes, in stock',
      'Thanks!',
    ]);
    expect((await inbox.list(a, { first: 10, after: null })).items).toEqual([
      expect.objectContaining({ id, unread: 1, waitingSince: later(60 * 31) }),
    ]);
  });

  it('shows a new session only what was written since it began, and refuses tokens that are none', async () => {
    const before = unwrap(
      await chat.start(
        a.shopId,
        { name: 'Sana', phone: '0321 7654321', body: 'My parcel?' },
        later(100),
      ),
    );
    // Someone else types Sana's number on another phone: they see their own message alone.
    const other = unwrap(
      await chat.start(
        a.shopId,
        { name: 'Not Sana', phone: '0321 7654321', body: 'Hi' },
        later(200),
      ),
    );
    expect(other.messages.map((message) => message.body)).toEqual(['Hi']);
    expect((await chat.read(a.shopId, before.token, later(201)))!.map((each) => each.body)).toEqual(
      ['My parcel?', 'Hi'],
    );
    // One conversation, named as last given.
    const sana = (await inbox.list(a, { first: 10, after: null })).items.filter(
      (each) => each.customerPhone === '+923217654321',
    );
    expect(sana).toEqual([expect.objectContaining({ customerName: 'Not Sana', unread: 2 })]);

    expect(await chat.read(a.shopId, 'x'.repeat(43), later(202))).toBeNull();
    expect(await chat.read(a.shopId, 'short', later(202))).toBeNull();
    expect(await chat.write(a.shopId, 'x'.repeat(43), { body: 'Hi' }, later(202))).toBeNull();
    // Another shop's token is none here.
    const b = tenant(newId());
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Mehr')`, [b.shopId]);
    unwrap(await chat.update(b, { enabled: true }));
    expect(await chat.read(b.shopId, before.token, later(203))).toBeNull();
    // Turned off, sessions read nothing.
    unwrap(await chat.update(a, { enabled: false }));
    expect(await chat.read(a.shopId, before.token, later(204))).toBeNull();
    unwrap(await chat.update(a, { enabled: true }));
  });

  it('lets a session write 30 messages an hour, and goes with an erased customer', async () => {
    const started = unwrap(
      await chat.start(a.shopId, { name: 'Hina', phone: '0333 1112223', body: '1' }, later(300)),
    );
    for (let message = 2; message <= 30; message++) {
      unwrap(await chat.write(a.shopId, started.token, { body: String(message) }, later(301)));
    }
    expect(errorsOf(await chat.write(a.shopId, started.token, { body: '31' }, later(302)))).toEqual(
      ['body: You have written a lot this hour: wait for the shop to answer'],
    );
    // An hour after the first, there is room again.
    unwrap(await chat.write(a.shopId, started.token, { body: '31' }, later(362)));

    await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.erase(
        tx,
        a.shopId,
        { id: newId(), phones: ['+923331112223'], email: null } as never,
        'system',
      ),
    );
    expect(await chat.read(a.shopId, started.token, later(363))).toBeNull();
  });
});

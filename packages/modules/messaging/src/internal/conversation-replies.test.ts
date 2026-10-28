import 'reflect-metadata';
import type { MutationResult, PlanAllowance, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONVERSATION_WINDOW_MS, ConversationsService } from './conversations.service.js';
import { MessagingEvents } from './events.js';
import { ReplyTimesService } from './reply-times.service.js';
import { SUPPORT_AGENT_DAILY, SupportAgentService } from './support-agent.service.js';
import { WHATSAPP_CLOUD } from './providers.js';
import { FakeGraph, NUMBER, SHARED_NUMBER, SHARED_TOKEN, TOKEN, WABA } from './test-support.js';
import type { WhatsAppAccountsService, WhatsAppSender } from './whatsapp-accounts.service.js';
import type { InboundMessage } from './whatsapp-webhook.js';

const server = testDatabaseServer();

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      role: 'confirmation_agent',
      authenticatedAt: new Date(),
    },
    scopes: new Set(['write_conversations']),
  };
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

const AYESHA = '+923001234567';
const BILAL = '+923217654321';
const WROTE = new Date('2026-10-17T09:00:00Z');
const SOON = new Date(WROTE.getTime() + 60_000);

describe.skipIf(!server)('Replies from the inbox (MSG-05, ADR-546)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let graph: FakeGraph;
  let inbox: ConversationsService;
  /** The shop's own number as its connection keeps it: B's, until it is disconnected. */
  let senders: Map<string, WhatsAppSender>;
  const a = tenant(newId());
  const b = tenant(newId());

  function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
      from: AYESHA,
      text: 'Is the lawn suit in medium?',
      replyTo: null,
      payload: null,
      at: WROTE,
      id: `wamid.${newId()}`,
      to: SHARED_NUMBER,
      mediaKind: null,
      ...overrides,
    };
  }

  /** A's conversation with `phone`, who wrote to Hatti's shared number after A wrote to them. */
  async function sharedConversation(phone = AYESHA): Promise<string> {
    await admin.query(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
               provider_message_id, sent_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', $3, 'sent', $4, $5, now())`,
      [a.shopId, phone, `test:${newId()}`, WHATSAPP_CLOUD, `wamid.${newId()}`],
    );
    expect(await inbox.recordInbound(inbound({ from: phone }))).toBe(a.shopId);
    const { items } = await inbox.list(a, { first: 10, after: null });
    return items.find((each) => each.customerPhone === phone)!.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'conversation-replies-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    await admin.query(
      `INSERT INTO messaging.whatsapp_accounts
              (shop_id, business_account_id, phone_number_id, display_phone_number,
               verified_name, access_token, pin)
       VALUES ($1, $2, $3, '+92 300 1234567', 'B', 'sealed', 'sealed')`,
      [b.shopId, WABA, NUMBER],
    );
    graph = new FakeGraph();
    senders = new Map();
    const accounts = {
      senderOf: async (shopId: string) => senders.get(shopId) ?? null,
    } as unknown as WhatsAppAccountsService;
    inbox = new ConversationsService(
      db,
      {
        baseUrl: await graph.start(),
        version: 'v26.0',
        shared: { phoneNumberId: SHARED_NUMBER, accessToken: SHARED_TOKEN },
      },
      accounts,
    );
  });

  afterAll(async () => {
    await graph?.stop();
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    graph.sent.length = 0;
    graph.messageError = null;
    senders.clear();
    senders.set(b.shopId, { businessAccountId: WABA, phoneNumberId: NUMBER, accessToken: TOKEN });
    await admin.query(
      'DELETE FROM messaging.conversations; DELETE FROM messaging.messages; ' +
        'DELETE FROM platform.outbox_events',
    );
  });

  it("keeps since when a customer waits, until answered or closed, overdue past the shop's target (ADR-760)", async () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    for (const phone of [AYESHA, BILAL]) {
      await admin.query(
        `INSERT INTO messaging.messages
                (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
                 provider_message_id, sent_at)
         VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', $3, 'sent', $4, $5, now())`,
        [a.shopId, phone, `test:${newId()}`, WHATSAPP_CLOUD, `wamid.${newId()}`],
      );
    }
    const first = minutes(-60);
    await inbox.recordInbound(inbound({ at: first }));
    const ayesha = async () =>
      (await inbox.list(a, { first: 10, after: null })).items.find(
        (each) => each.customerPhone === AYESHA,
      )!;
    // No target, no time to answer by.
    expect(await ayesha()).toMatchObject({ waitingSince: first, answerBy: null });
    expect(await inbox.overdueCount(a)).toBe(0);

    await admin.query(
      `INSERT INTO messaging.settings (shop_id, reply_target_minutes) VALUES ($1, 30)
           ON CONFLICT (shop_id) DO UPDATE SET reply_target_minutes = 30`,
      [a.shopId],
    );
    // Writing again waits from the first message still.
    await inbox.recordInbound(inbound({ at: minutes(-55), text: 'Hello?' }));
    await inbox.recordInbound(inbound({ from: BILAL, at: minutes(-10) }));
    const { id, ...waiting } = await ayesha();
    expect(waiting).toMatchObject({
      waitingSince: first,
      answerBy: new Date(first.getTime() + 30 * 60_000),
    });
    expect(await inbox.overdueCount(a)).toBe(1);
    expect(await inbox.overdueCount(a, new Date(first.getTime() + 29 * 60_000))).toBe(0);
    expect(await inbox.overdueCount(b)).toBe(0);
    // Each message says whether it began the wait, for its push (ADR-761).
    const { rows: received } = await admin.query<{ payload: { startedWaiting: boolean } }>(
      `SELECT payload FROM platform.outbox_events
        WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id`,
      [MessagingEvents.ConversationMessageReceived, id],
    );
    expect(received.map((each) => each.payload.startedWaiting)).toEqual([true, false]);
    const overdue = await inbox.list(a, { first: 10, after: null, overdue: true });
    expect(overdue.items.map((each) => each.id)).toEqual([id]);

    // Answered, it waits no more; written to again, it waits from then; closed, not at all.
    const { conversation } = unwrap(await inbox.reply(a, id, 'Ji, abhi batate hain', minutes(0)));
    expect(conversation).toMatchObject({ waitingSince: null, answerBy: null });
    expect(await inbox.overdueCount(a)).toBe(0);
    const again = minutes(1);
    await inbox.recordInbound(inbound({ at: again, text: 'Shukriya' }));
    expect(await ayesha()).toMatchObject({ waitingSince: again });
    expect(await inbox.setStatus(a, id, 'closed')).toMatchObject({ waitingSince: null });
    expect(await inbox.setStatus(a, id, 'open')).toMatchObject({ waitingSince: null });
  });

  it('keeps how long each customer waited for an answer and who gave it, reported by period (ADR-763)', async () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    for (const phone of [AYESHA, BILAL]) {
      await admin.query(
        `INSERT INTO messaging.messages
                (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
                 provider_message_id, sent_at)
         VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', $3, 'sent', $4, $5, now())`,
        [a.shopId, phone, `test:${newId()}`, WHATSAPP_CLOUD, `wamid.${newId()}`],
      );
    }
    await admin.query(
      `INSERT INTO messaging.settings (shop_id, reply_target_minutes) VALUES ($1, 30)
           ON CONFLICT (shop_id) DO UPDATE SET reply_target_minutes = 30`,
      [a.shopId],
    );
    await admin.query('DELETE FROM messaging.conversation_answers');
    const other: TenantContext = {
      ...a,
      actor: {
        ...(a.actor as Extract<TenantContext['actor'], { kind: 'staff' }>),
        userId: newId(),
      },
    };
    const idOf = async (phone: string) =>
      (await inbox.list(a, { first: 10, after: null })).items.find(
        (each) => each.customerPhone === phone,
      )!.id;
    // Ayesha waits 40 minutes; Bilal 5, answered by another; answering again is no new answer.
    await inbox.recordInbound(inbound({ at: minutes(-60) }));
    unwrap(await inbox.reply(a, await idOf(AYESHA), 'Ji', minutes(-20)));
    await inbox.recordInbound(inbound({ from: BILAL, at: minutes(-15) }));
    unwrap(await inbox.reply(other, await idOf(BILAL), 'Ji', minutes(-10)));
    unwrap(await inbox.reply(other, await idOf(BILAL), 'Aur kuch?', minutes(-9)));

    const times = new ReplyTimesService(db);
    const report = unwrap(await times.report(a, { from: minutes(-120), before: minutes(1) }));
    expect(report).toMatchObject({
      answered: 2,
      medianWaitSeconds: 1350,
      withinTarget: 1,
      replyTargetMinutes: 30,
    });
    expect(
      report.byActor
        .map((row) => [row.actor.id, row.answered, row.medianWaitSeconds, row.withinTarget])
        .sort(),
    ).toEqual(
      [
        [(a.actor as { userId: string }).userId, 1, 2400, 0],
        [(other.actor as { userId: string }).userId, 1, 300, 1],
      ].sort(),
    );
    // Another period, another shop: nothing.
    expect(unwrap(await times.report(a, { from: minutes(-600), before: minutes(-300) }))).toEqual({
      answered: 0,
      medianWaitSeconds: null,
      withinTarget: 0,
      replyTargetMinutes: 30,
      byActor: [],
    });
    expect(
      unwrap(await times.report(b, { from: minutes(-120), before: minutes(1) })),
    ).toMatchObject({ answered: 0, withinTarget: null });
    expect(await times.report(a, { from: minutes(0), before: minutes(-1) })).toMatchObject({
      ok: false,
      errors: [{ field: ['before'], code: 'INVALID' }],
    });
    await admin.query('DELETE FROM messaging.settings WHERE shop_id = $1', [a.shopId]);
  });

  it('answers from the shared number the customer wrote to, and reads the conversation', async () => {
    const id = await sharedConversation();
    const { conversation, message } = unwrap(
      await inbox.reply(a, id, '  Yes, medium is in stock.  ', SOON),
    );
    expect(graph.sent).toEqual([
      {
        from: SHARED_NUMBER,
        id: 'wamid.out-1',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: AYESHA.slice(1),
          type: 'text',
          text: { body: 'Yes, medium is in stock.', preview_url: true },
        },
      },
    ]);
    expect(message).toMatchObject({
      direction: 'outbound',
      body: 'Yes, medium is in stock.',
      status: 'sent',
      error: null,
      at: SOON,
    });
    expect(conversation).toMatchObject({
      unread: 0,
      lastMessageAt: SOON,
      lastInboundAt: WROTE,
      lastMessage: { id: message.id, direction: 'outbound' },
    });
    // Kept with who wrote it, and the event.
    const { rows } = await admin.query<{ actor_kind: string; actor_id: string }>(
      `SELECT actor_kind, actor_id FROM messaging.conversation_messages
        WHERE direction = 'outbound'`,
    );
    expect(rows).toEqual([
      { actor_kind: 'staff', actor_id: (a.actor as { userId: string }).userId },
    ]);
    const events = await admin.query<{ aggregate_id: string }>(
      'SELECT aggregate_id FROM platform.outbox_events WHERE event_type = $1',
      [MessagingEvents.ConversationReplied],
    );
    expect(events.rows).toEqual([{ aggregate_id: id }]);
    const page = await inbox.messages(a, id, { first: 10, before: null });
    expect(page.items.map((each) => [each.direction, each.body])).toEqual([
      ['outbound', 'Yes, medium is in stock.'],
      ['inbound', 'Is the lawn suit in medium?'],
    ]);
  });

  it("answers from the shop's own number the customer wrote to, while it is connected", async () => {
    expect(await inbox.recordInbound(inbound({ to: NUMBER }))).toBe(b.shopId);
    const [conversation] = (await inbox.list(b, { first: 1, after: null })).items;
    unwrap(await inbox.reply(b, conversation!.id, 'Ji, mil jayega', SOON));
    expect(graph.sent.map((each) => [each.from, each.body.to])).toEqual([
      [NUMBER, AYESHA.slice(1)],
    ]);
    // Disconnected, or another number connected: not from Hatti's, where she did not write.
    senders.delete(b.shopId);
    expect(await inbox.reply(b, conversation!.id, 'Hello?', SOON)).toEqual({
      ok: false,
      errors: [
        {
          field: ['id'],
          code: 'UNAVAILABLE',
          message: 'The number the customer wrote to is no longer connected',
        },
      ],
    });
    expect(graph.sent).toHaveLength(1);
  });

  it('answers only within a day of the last message, in words, of another shop not at all', async () => {
    const id = await sharedConversation();
    const late = new Date(WROTE.getTime() + CONVERSATION_WINDOW_MS);
    expect(await inbox.reply(a, id, 'Sorry for the wait', late)).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], code: 'WINDOW_CLOSED' }],
    });
    expect(await inbox.reply(a, id, '   ', SOON)).toMatchObject({
      ok: false,
      errors: [{ field: ['body'], code: 'BLANK' }],
    });
    expect(await inbox.reply(a, id, 'x'.repeat(4097), SOON)).toMatchObject({
      ok: false,
      errors: [{ field: ['body'], code: 'TOO_LONG' }],
    });
    expect(await inbox.reply(b, id, 'Not mine', SOON)).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    expect(graph.sent).toEqual([]);
    // Writing again opens the day again.
    await inbox.recordInbound(inbound({ at: new Date(late.getTime() - 60_000), text: 'Hello?' }));
    unwrap(await inbox.reply(a, id, 'Sorry for the wait', late));
  });

  it('keeps nothing WhatsApp refuses, and says whether to try again', async () => {
    const id = await sharedConversation();
    graph.messageError = { code: 131026, message: 'Message undeliverable' };
    expect(await inbox.reply(a, id, 'Hello', SOON)).toEqual({
      ok: false,
      errors: [
        { field: ['body'], code: 'NOT_SENT', message: 'WhatsApp 131026: Message undeliverable' },
      ],
    });
    graph.messageError = { code: 2, message: 'Service temporarily unavailable', status: 503 };
    expect(await inbox.reply(a, id, 'Hello', SOON)).toMatchObject({
      ok: false,
      errors: [{ code: 'UNAVAILABLE' }],
    });
    const { rows } = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM messaging.conversation_messages
        WHERE direction = 'outbound'`,
    );
    expect(rows[0]!.count).toBe(0);
    // Without Hatti's shared number set up, nothing is sent.
    const unset = new ConversationsService(db, null, null);
    expect(await unset.reply(a, id, 'Hello', SOON)).toMatchObject({
      ok: false,
      errors: [{ code: 'UNAVAILABLE', message: 'WhatsApp is not set up to send replies' }],
    });
  });

  it("follows a reply to delivery as WhatsApp's statuses say, never back", async () => {
    const id = await sharedConversation();
    const other = await sharedConversation(BILAL);
    const { message } = unwrap(await inbox.reply(a, id, 'Ji', SOON));
    const { message: second } = unwrap(await inbox.reply(a, other, 'Ji', SOON));
    const status = (providerMessageId: string, kind: 'delivered' | 'read' | 'failed') => ({
      providerMessageId,
      status: kind,
      at: SOON,
      error: kind === 'failed' ? 'WhatsApp 131047: Re-engagement message' : null,
    });
    const stranger = status('wamid.someone-else', 'read');
    expect(
      await inbox.recordStatuses([
        status('wamid.out-1', 'delivered'),
        status('wamid.out-1', 'read'),
        status('wamid.out-2', 'failed'),
        stranger,
      ]),
    ).toEqual([stranger]);
    // Failed after it was read, or delivered after: no change.
    await inbox.recordStatuses([
      status('wamid.out-1', 'failed'),
      status('wamid.out-1', 'delivered'),
    ]);
    const shown = async (conversationId: string) =>
      (await inbox.messages(a, conversationId, { first: 1, before: null })).items[0];
    expect(await shown(id)).toMatchObject({ id: message.id, status: 'read', error: null });
    expect(await shown(other)).toMatchObject({
      id: second.id,
      status: 'failed',
      error: 'WhatsApp 131047: Re-engagement message',
    });
    expect((await inbox.get(a, other))!.lastMessage).toMatchObject({ status: 'failed' });
  });

  it("sends the AI's reply as the AI's, leaving staff's reply times and unread as they were (ADR-849)", async () => {
    const id = await sharedConversation();
    const sent = unwrap(await inbox.reply(a, id, 'Ji, medium mein hai.', SOON, { ai: true }));
    expect(sent.message).toMatchObject({ body: 'Ji, medium mein hai.', byAi: true });
    expect(graph.sent.at(-1)?.body).toMatchObject({ text: { body: 'Ji, medium mein hai.' } });
    expect(sent.conversation).toMatchObject({ unread: 1, waitingSince: null });
    expect(sent.conversation.lastMessage).toMatchObject({ byAi: true });
    const { rows } = await admin.query<{ actor_kind: string; actor_id: string | null }>(
      `SELECT actor_kind, actor_id FROM messaging.conversation_messages
        WHERE conversation_id = $1 AND direction = 'outbound'`,
      [id],
    );
    expect(rows).toEqual([{ actor_kind: 'ai', actor_id: null }]);
    expect(
      (
        await admin.query(
          'SELECT 1 FROM messaging.conversation_answers WHERE conversation_id = $1',
          [id],
        )
      ).rows,
    ).toEqual([]);
    const { items } = await inbox.messages(a, id, { first: 5, before: null });
    expect(items.map((message) => message.byAi)).toEqual([true, false]);

    // The shop's setting, off until it turns it on.
    const agent = new SupportAgentService(db);
    expect(await agent.settings(a)).toEqual({
      enabled: false,
      answeredToday: 0,
      limitPerDay: SUPPORT_AGENT_DAILY,
    });
    expect(unwrap(await agent.update(a, { enabled: true })).enabled).toBe(true);
    expect((await agent.settings(b)).enabled).toBe(false);
    // On a plan without it, it is not turned on, and answers no one though it was on.
    const starter = new SupportAgentService(db, {
      excludes: async (_shopId: string, feature: string) =>
        feature === 'aiSupportAgent' ? 'Starter' : null,
    } as unknown as PlanAllowance);
    const refused = await starter.update(b, { enabled: true });
    expect(!refused.ok && refused.errors[0]).toMatchObject({
      code: 'PROHIBITED',
      message: "The Starter plan doesn't include AI answers: choose the Growth plan for them",
    });
    expect(unwrap(await starter.update(a, { enabled: false })).enabled).toBe(false);
    unwrap(await agent.update(a, { enabled: true }));
    await inbox.recordInbound(inbound({ text: 'aur kuch?', at: SOON, id: `wamid.${newId()}` }));
    const { rows: written } = await admin.query<{ id: string }>(
      `SELECT id FROM messaging.conversation_messages
        WHERE conversation_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
      [id],
    );
    expect(await agent.taskOf(a.shopId, id, written[0]!.id, SOON)).not.toBeNull();
    expect(await starter.taskOf(a.shopId, id, written[0]!.id, SOON)).toBeNull();
  });
});

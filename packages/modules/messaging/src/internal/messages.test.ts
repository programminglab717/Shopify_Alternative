import 'reflect-metadata';
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageCharges, type MessageCost } from './charges.js';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import { MessagesService, type MessageToQueue } from './messages.service.js';
import { MessagingSettingsService } from './settings.service.js';

const server = testDatabaseServer();

const AYESHA = '+923001234567';
const BILAL = '+923217654321';

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_settings', 'read_orders']),
  };
}

function placed(orderId: string, recipient = AYESHA): MessageToQueue {
  return {
    kind: 'order_placed',
    recipient,
    orderId,
    variables: { name: 'Ayesha', shop: 'Zari', order: '#1001', total: 'Rs 2,500' },
    dedupeKey: `order_placed:${orderId}`,
  };
}

/** What the messages paid for were charged, and given back: a wallet kept in memory. */
class RecordedCharges extends MessageCharges {
  readonly charged: { shopId: string; id: string; cost: MessageCost; inTx: boolean }[] = [];
  readonly refunded: { shopId: string; id: string }[] = [];

  priceOf(cost: MessageCost): bigint {
    return 4_62n * BigInt(cost.parts);
  }

  async balanceOf(): Promise<bigint> {
    return 0n;
  }

  async chargeIn(tx: Tx, shopId: string, id: string, cost: MessageCost): Promise<void> {
    this.charged.push({ shopId, id, cost, inTx: typeof tx.execute === 'function' });
  }

  async refundIn(_tx: Tx, shopId: string, id: string): Promise<void> {
    this.refunded.push({ shopId, id });
  }
}

describe.skipIf(!server)("Messages: queued once, sent, followed, and customers' opt-outs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let messages: MessagesService;
  let settings: MessagingSettingsService;
  const a = tenant(newId());
  const b = tenant(newId());

  /** Each of the shop's messages, the earliest first, as [kind, channel, status, replaces?]. */
  const rows = async (shopId = a.shopId) =>
    (
      await admin.query<{
        id: string;
        kind: string;
        channel: string;
        status: string;
        attempts: number;
        error: string | null;
        replaces: string | null;
        dedupe_key: string;
      }>(
        `SELECT id, kind, channel, status, attempts, error, replaces, dedupe_key
           FROM messaging.messages WHERE shop_id = $1 ORDER BY created_at, id`,
        [shopId],
      )
    ).rows;

  /** One second on: the messages queued now are due. */
  const soon = () => new Date(Date.now() + 1_000);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'messaging-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    messages = new MessagesService(db);
    settings = new MessagingSettingsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM messaging.messages; DELETE FROM messaging.opt_outs; ' +
        'DELETE FROM messaging.settings; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it("queues a message once by its key, on the shop's channel and in its language", async () => {
    const order = newId();
    const id = await messages.queue(a.shopId, placed(order));
    expect(id).toEqual(expect.any(String));
    // The event came twice: one message all the same.
    expect(await messages.queue(a.shopId, placed(order))).toBeNull();
    expect((await rows()).map((row) => [row.kind, row.channel, row.status])).toEqual([
      ['order_placed', 'whatsapp', 'pending'],
    ]);
    const { rows: queued } = await admin.query<{ language: string; variables: object }>(
      'SELECT language, variables FROM messaging.messages',
    );
    expect(queued).toEqual([
      {
        language: 'en',
        variables: { name: 'Ayesha', shop: 'Zari', order: '#1001', total: 'Rs 2,500' },
      },
    ]);

    // Updates by SMS, in Urdu; placed orders no more.
    unwrap(
      await settings.update(a, {
        routing: 'economy',
        language: 'ur',
        disabled: ['order_placed'],
      }),
    );
    expect(await messages.queue(a.shopId, placed(newId()))).toBeNull();
    const shipped = newId();
    expect(
      await messages.queue(a.shopId, {
        kind: 'order_shipped',
        recipient: AYESHA,
        orderId: shipped,
        variables: { shop: 'Zari', order: '#1002', courier: 'Leopards', tracking: 'LP1' },
        dedupeKey: `order_shipped:${shipped}`,
      }),
    ).not.toBeNull();
    // A question stays on WhatsApp, for its buttons.
    const asking = await messages.queue(a.shopId, {
      ...placed(newId()),
      kind: 'order_confirmation',
      dedupeKey: `order_confirmation:${shipped}`,
    });
    const { rows: latest } = await admin.query<{ kind: string; channel: string; language: string }>(
      `SELECT kind, channel, language FROM messaging.messages
        WHERE kind IN ('order_shipped', 'order_confirmation') ORDER BY created_at`,
    );
    expect(latest).toEqual([
      { kind: 'order_shipped', channel: 'sms', language: 'ur' },
      { kind: 'order_confirmation', channel: 'whatsapp', language: 'ur' },
    ]);

    // Its link, once it is made; a message gone out keeps what it said.
    await db.tenant(a.shopId, (tx) =>
      messages.linkIn(tx, a.shopId, asking!, 'https://hatti.pk/o/abc'),
    );
    await db.tenant(a.shopId, (tx) => messages.linkIn(tx, a.shopId, id!, 'https://hatti.pk/o/x'));
    await admin.query(`UPDATE messaging.messages SET status = 'sent' WHERE id = $1`, [id]);
    await db.tenant(a.shopId, (tx) => messages.linkIn(tx, a.shopId, id!, 'https://hatti.pk/o/y'));
    expect(await db.tenant(a.shopId, (tx) => messages.messageIn(tx, a.shopId, asking!))).toEqual({
      kind: 'order_confirmation',
      orderId: expect.any(String),
      variables: {
        name: 'Ayesha',
        shop: 'Zari',
        order: '#1001',
        total: 'Rs 2,500',
        url: 'https://hatti.pk/o/abc',
      },
    });
    expect(
      (await db.tenant(a.shopId, (tx) => messages.messageIn(tx, a.shopId, id!)))?.variables.url,
    ).toBe('https://hatti.pk/o/x');
    expect(await db.tenant(b.shopId, (tx) => messages.messageIn(tx, b.shopId, id!))).toBeNull();
  });

  it('drops a code once it is sent, after any SMS in its place took it, and always sends codes', async () => {
    const code = (n: number) => ({
      kind: 'one_time_code' as const,
      recipient: AYESHA,
      variables: { shop: 'Zari', code: `00000${n}` },
      dedupeKey: `one_time_code:${n}`,
    });
    // A shop cannot turn codes off: shoppers ask for them.
    const refused = await settings.update(a, { disabled: ['one_time_code'] });
    expect(
      refused.ok || refused.errors.map((error) => [error.field.join('.'), error.code]),
    ).toEqual([['input.disabled', 'INVALID']]);
    unwrap(await settings.update(a, { routing: 'economy' }));
    const [sent, refusedByWhatsApp, bySms] = [
      await messages.queue(a.shopId, code(1)),
      await messages.queue(a.shopId, code(2)),
      await messages.queue(a.shopId, { ...code(3), channel: 'sms' }),
    ];
    const at = soon();
    await messages.claim(a.shopId, at, 10, 1);
    await messages.settle(
      a.shopId,
      [
        { id: sent!, status: 'sent', provider: 'whatsapp_cloud', providerMessageId: 'wamid.c1' },
        { id: refusedByWhatsApp!, status: 'failed', error: 'WhatsApp 131026: x', replace: true },
      ],
      at,
    );
    const { rows: settled } = await admin.query<{
      channel: string;
      status: string;
      code: string | null;
    }>(
      `SELECT channel, status, variables ->> 'code' AS code FROM messaging.messages
        ORDER BY created_at, id`,
    );
    // Not by SMS for economy: a code asks for an answer. The one shopper's choice is.
    expect(settled).toEqual([
      { channel: 'whatsapp', status: 'sent', code: null },
      { channel: 'whatsapp', status: 'failed', code: null },
      { channel: 'sms', status: 'pending', code: '000003' },
      { channel: 'sms', status: 'pending', code: '000002' },
    ]);
    // Failed after it was sent: no SMS without its code, and none late.
    await messages.recordStatuses([{ providerMessageId: 'wamid.c1', status: 'failed', at }]);
    await admin.query(`UPDATE messaging.messages SET sent_at = now() - interval '20 minutes'`);
    expect(await messages.replaceUndelivered(new Date(), 15 * 60_000, 24 * 60 * 60_000)).toBe(0);
    expect(await rows()).toHaveLength(4);
    expect(bySms).not.toBeNull();
  });

  it("records a customer's answer as the message's, for the worker to act on", async () => {
    const order = newId();
    const id = await messages.queue(a.shopId, {
      ...placed(order),
      kind: 'order_confirmation',
      dedupeKey: `order_confirmation:${order}`,
    });
    await admin.query(
      `UPDATE messaging.messages SET status = 'sent', provider = 'whatsapp_cloud',
              provider_message_id = 'wamid.ask' WHERE id = $1`,
      [id],
    );
    const at = new Date('2026-10-02T09:30:00.000Z');
    expect(
      await messages.recordReply({ replyTo: 'wamid.ask', from: AYESHA, answer: 'confirm', at }),
    ).toBe(true);
    // Another number, or a message not known: nothing.
    expect(
      await messages.recordReply({ replyTo: 'wamid.ask', from: BILAL, answer: 'cancel', at }),
    ).toBe(false);
    expect(
      await messages.recordReply({ replyTo: 'wamid.none', from: AYESHA, answer: 'cancel', at }),
    ).toBe(false);
    const { rows: events } = await admin.query(
      `SELECT shop_id, event_type, aggregate_type, aggregate_id, payload
         FROM platform.outbox_events ORDER BY id`,
    );
    expect(events).toEqual([
      {
        shop_id: a.shopId,
        event_type: 'message.replied',
        aggregate_type: 'message',
        aggregate_id: id,
        payload: {
          kind: 'order_confirmation',
          orderId: order,
          answer: 'confirm',
          channel: 'whatsapp',
          at: at.toISOString(),
        },
      },
    ]);
  });

  it('gives each message due to one sender, and settles how sending went', async () => {
    for (let i = 0; i < 5; i++) await messages.queue(a.shopId, placed(newId()));
    await messages.queue(b.shopId, placed(newId(), BILAL));
    expect((await messages.dueShops(soon())).sort()).toEqual([a.shopId, b.shopId].sort());
    // Not due yet.
    expect(await messages.dueShops(new Date(Date.now() - 60_000))).toEqual([]);

    // Two senders at once take different messages, each a try.
    const at = soon();
    const [first, second] = await Promise.all([
      messages.claim(a.shopId, at, 3, 300_000),
      messages.claim(a.shopId, at, 3, 300_000),
    ]);
    const taken = [...first, ...second].map((message) => message.id);
    expect(taken).toHaveLength(5);
    expect(new Set(taken).size).toBe(5);
    expect([...first, ...second].every((message) => message.attempts === 1)).toBe(true);
    expect(first[0]).toMatchObject({
      kind: 'order_placed',
      channel: 'whatsapp',
      recipient: AYESHA,
      language: 'en',
      variables: { name: 'Ayesha', shop: 'Zari', order: '#1001', total: 'Rs 2,500' },
    });
    // Leased: not due again until the lease ends.
    expect(await messages.claim(a.shopId, soon(), 10, 300_000)).toEqual([]);
    expect(await messages.dueShops(soon())).toEqual([b.shopId]);

    const [sent, later, refused, replaced, stopped] = (await rows()).map((row) => row.id);
    await messages.settle(
      a.shopId,
      [
        { id: sent!, status: 'sent', provider: 'whatsapp_cloud', providerMessageId: 'wamid.1' },
        {
          id: later!,
          status: 'pending',
          error: 'WhatsApp 130429: Rate limit hit',
          nextAttemptAt: new Date(at.getTime() + 60_000),
        },
        { id: refused!, status: 'failed', error: 'No WhatsApp number', replace: false },
        { id: replaced!, status: 'failed', error: 'WhatsApp 131026: undeliverable', replace: true },
        { id: stopped!, status: 'skipped', error: 'Not sent: the customer asked the shop to stop' },
      ],
      at,
    );
    // Settled once: a second word on a message no longer pending changes nothing.
    await messages.settle(
      a.shopId,
      [{ id: sent!, status: 'failed', error: 'late', replace: true }],
      at,
    );
    const settled = await rows();
    expect(
      settled.map((row) => [row.channel, row.status, row.error, row.replaces, row.dedupe_key]),
    ).toEqual([
      ['whatsapp', 'sent', null, null, expect.stringMatching(/^order_placed:/)],
      ['whatsapp', 'pending', 'WhatsApp 130429: Rate limit hit', null, expect.any(String)],
      ['whatsapp', 'failed', 'No WhatsApp number', null, expect.any(String)],
      ['whatsapp', 'failed', 'WhatsApp 131026: undeliverable', null, expect.any(String)],
      ['whatsapp', 'skipped', expect.stringContaining('stop'), null, expect.any(String)],
      ['sms', 'pending', null, replaced, `${settled[3]!.dedupe_key}:sms`],
    ]);
    const { rows: provider } = await admin.query(
      `SELECT provider, provider_message_id, sent_at FROM messaging.messages WHERE id = $1`,
      [sent],
    );
    expect(provider).toEqual([
      { provider: 'whatsapp_cloud', provider_message_id: 'wamid.1', sent_at: at },
    ]);
    // The one tried again is due when it said, a second try.
    expect(await messages.claim(a.shopId, new Date(at.getTime() + 61_000), 10, 1)).toMatchObject([
      { id: later, attempts: 2 },
      { channel: 'sms', attempts: 1 },
    ]);
  });

  it('sends by SMS what WhatsApp took and did not deliver, once, and within a day', async () => {
    for (let i = 0; i < 5; i++) await messages.queue(a.shopId, placed(newId()));
    const [late, delivered, recent, old, logged] = (await rows()).map((row) => row.id);
    const now = Date.now();
    const sentAgo = async (id: string, ms: number, status = 'sent', provider = 'whatsapp_cloud') =>
      admin.query(
        `UPDATE messaging.messages SET status = $2, provider = $4,
                provider_message_id = $1, sent_at = $3 WHERE id = $1`,
        [id, status, new Date(now - ms), provider],
      );
    await sentAgo(late!, 20 * 60_000);
    await sentAgo(delivered!, 20 * 60_000, 'delivered');
    await sentAgo(recent!, 5 * 60_000);
    await sentAgo(old!, 2 * 24 * 60 * 60_000);
    // Written to the log, in development: no word of delivery ever comes.
    await sentAgo(logged!, 20 * 60_000, 'sent', 'log');

    const day = 24 * 60 * 60_000;
    expect(await messages.replaceUndelivered(new Date(now), 15 * 60_000, day)).toBe(1);
    expect(await messages.replaceUndelivered(new Date(now), 15 * 60_000, day)).toBe(0);
    const sms = (await rows()).filter((row) => row.channel === 'sms');
    expect(sms.map((row) => [row.status, row.replaces])).toEqual([['pending', late]]);
  });

  it("follows WhatsApp's word on each message forward alone, an SMS going for what failed", async () => {
    for (let i = 0; i < 3; i++) await messages.queue(a.shopId, placed(newId()));
    await messages.queue(b.shopId, placed(newId(), BILAL));
    const ids = [
      ...(await rows()).map((row) => row.id),
      ...(await rows(b.shopId)).map((r) => r.id),
    ];
    const at = soon();
    for (const [index, id] of ids.entries()) {
      const shopId = index < 3 ? a.shopId : b.shopId;
      await messages.claim(shopId, at, 10, 1);
      await messages.settle(
        shopId,
        [{ id, status: 'sent', provider: 'whatsapp_cloud', providerMessageId: `wamid.${index}` }],
        at,
      );
    }
    const t = (minutes: number) => new Date(at.getTime() + minutes * 60_000);
    const unknown = { providerMessageId: 'wamid.unknown', status: 'delivered', at: t(1) } as const;
    expect(
      await messages.recordStatuses([
        { providerMessageId: 'wamid.0', status: 'read', at: t(2) },
        // Late, and behind what is known: ignored.
        { providerMessageId: 'wamid.0', status: 'delivered', at: t(1) },
        { providerMessageId: 'wamid.1', status: 'delivered', at: t(1) },
        { providerMessageId: 'wamid.1', status: 'failed', at: t(3), error: 'too late' },
        { providerMessageId: 'wamid.2', status: 'failed', at: t(1), error: 'WhatsApp 131026: x' },
        { providerMessageId: 'wamid.3', status: 'delivered', at: t(1) },
        unknown,
      ]),
    ).toEqual({ changed: 4, unmatched: [unknown] });
    // Heard again, as webhooks are: nothing more.
    expect(
      await messages.recordStatuses([
        { providerMessageId: 'wamid.2', status: 'failed', at: t(1), error: 'WhatsApp 131026: x' },
      ]),
    ).toEqual({ changed: 0, unmatched: [] });
    const { rows: followed } = await admin.query<{
      provider_message_id: string | null;
      channel: string;
      status: string;
      error: string | null;
      delivered_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT provider_message_id, channel, status, error, delivered_at, read_at
         FROM messaging.messages ORDER BY created_at, id`,
    );
    expect(followed).toEqual([
      // Read before WhatsApp said delivered: read is delivered.
      {
        provider_message_id: 'wamid.0',
        channel: 'whatsapp',
        status: 'read',
        error: null,
        delivered_at: t(2),
        read_at: t(2),
      },
      {
        provider_message_id: 'wamid.1',
        channel: 'whatsapp',
        status: 'delivered',
        error: null,
        delivered_at: t(1),
        read_at: null,
      },
      {
        provider_message_id: 'wamid.2',
        channel: 'whatsapp',
        status: 'failed',
        error: 'WhatsApp 131026: x',
        delivered_at: null,
        read_at: null,
      },
      {
        provider_message_id: 'wamid.3',
        channel: 'whatsapp',
        status: 'delivered',
        error: null,
        delivered_at: t(1),
        read_at: null,
      },
      {
        provider_message_id: null,
        channel: 'sms',
        status: 'pending',
        error: null,
        delivered_at: null,
        read_at: null,
      },
    ]);
  });

  it('pays for each message sent, once, and gives back what WhatsApp could not deliver', async () => {
    const charges = new RecordedCharges();
    const paying = new MessagesService(db, charges);
    await paying.queue(a.shopId, placed(newId()));
    await paying.queue(a.shopId, { ...placed(newId()), channel: 'sms' });
    await paying.queue(a.shopId, placed(newId()));
    const [whatsapp, sms, failed] = (await rows()).map((row) => row.id);
    const at = soon();
    await paying.claim(a.shopId, at, 10, 1);
    await paying.settle(
      a.shopId,
      [
        { id: whatsapp!, status: 'sent', provider: 'whatsapp_cloud', providerMessageId: 'wamid.p' },
        { id: sms!, status: 'sent', provider: 'sms_gateway', providerMessageId: 'sms-1' },
        { id: failed!, status: 'failed', error: 'No WhatsApp number', replace: false },
      ],
      at,
    );
    // Settled again: nothing more is charged.
    await paying.settle(
      a.shopId,
      [{ id: sms!, status: 'sent', provider: 'sms_gateway', providerMessageId: 'sms-1' }],
      at,
    );
    expect(charges.charged).toEqual([
      {
        shopId: a.shopId,
        id: whatsapp,
        cost: { channel: 'whatsapp', category: 'utility', parts: 1 },
        inTx: true,
      },
      {
        shopId: a.shopId,
        id: sms,
        cost: { channel: 'sms', category: 'utility', parts: 1 },
        inTx: true,
      },
    ]);

    // WhatsApp could not deliver it: what it was charged is given back, once.
    const undelivered = {
      providerMessageId: 'wamid.p',
      status: 'failed',
      at: new Date(at.getTime() + 60_000),
      error: 'WhatsApp 131026: undeliverable',
    } as const;
    expect(await paying.recordStatuses([undelivered])).toEqual({ changed: 1, unmatched: [] });
    expect(await paying.recordStatuses([undelivered])).toEqual({ changed: 0, unmatched: [] });
    expect(charges.refunded).toEqual([{ shopId: a.shopId, id: whatsapp }]);
  });

  it('hears "stop" for the shop it answered, or else the one that last wrote, there alone', async () => {
    expect(await messages.optOut('whatsapp', AYESHA, 'STOP')).toBeNull();
    const [first, second, third] = [newId(), newId(), newId()];
    await messages.queue(b.shopId, placed(first));
    await messages.queue(a.shopId, placed(second));
    await messages.queue(a.shopId, {
      ...placed(third),
      kind: 'order_cancelled',
      dedupeKey: `order_cancelled:${third}`,
    });
    // Shop A wrote last.
    expect(await messages.optOut('whatsapp', AYESHA, 'Band karo')).toBe(a.shopId);
    expect(await messages.optOut('whatsapp', AYESHA, 'stop')).toBe(a.shopId);
    expect((await rows()).map((row) => row.status)).toEqual(['skipped', 'skipped']);
    expect((await rows(b.shopId)).map((row) => row.status)).toEqual(['pending']);
    const { rows: optOuts } = await admin.query(
      'SELECT shop_id, channel, recipient, said FROM messaging.opt_outs',
    );
    // What they said first is kept.
    expect(optOuts).toEqual([
      { shop_id: a.shopId, channel: 'whatsapp', recipient: AYESHA, said: 'Band karo' },
    ]);
    expect([...(await messages.optedOut(a.shopId, 'whatsapp', [AYESHA, BILAL, AYESHA]))]).toEqual([
      AYESHA,
    ]);
    expect([...(await messages.optedOut(a.shopId, 'sms', [AYESHA]))]).toEqual([]);
    expect([...(await messages.optedOut(b.shopId, 'whatsapp', [AYESHA]))]).toEqual([]);

    // Answering shop B's message, sent before A's: B's.
    const [ofB] = await rows(b.shopId);
    await admin.query(
      `UPDATE messaging.messages SET status = 'sent', provider = 'whatsapp_cloud',
              provider_message_id = 'wamid.B' WHERE id = $1`,
      [ofB!.id],
    );
    expect(await messages.optOut('whatsapp', AYESHA, 'stop', 'wamid.B')).toBe(b.shopId);
    expect(await messages.optOut('whatsapp', BILAL, 'stop', 'wamid.unknown')).toBeNull();
    expect([...(await messages.optedOut(b.shopId, 'whatsapp', [AYESHA]))]).toEqual([AYESHA]);
  });

  it("lists the shop's own messages, the latest first, a page at a time", async () => {
    const orders = [newId(), newId(), newId()];
    for (const order of orders) await messages.queue(a.shopId, placed(order));
    await messages.queue(b.shopId, placed(newId(), BILAL));
    const [, , last] = (await rows()).map((row) => row.id);
    await admin.query(`UPDATE messaging.messages SET status = 'failed' WHERE id = $1`, [last]);

    const page = await messages.list(a, { first: 2, after: null });
    expect(page.hasNextPage).toBe(true);
    expect(page.items.map((item) => item.orderId)).toEqual([orders[2], orders[1]]);
    expect(page.items[0]).toMatchObject({
      kind: 'order_placed',
      channel: 'whatsapp',
      recipient: AYESHA,
      status: 'failed',
      attempts: 0,
      replacesId: null,
      sentAt: null,
    });
    const next = await messages.list(a, {
      first: 2,
      after: { id: page.items[1]!.id, createdAt: page.items[1]!.createdAtExactly },
    });
    expect(next).toMatchObject({ hasNextPage: false, items: [{ orderId: orders[0] }] });
    expect(
      (await messages.list(a, { first: 5, after: null, status: 'failed' })).items,
    ).toHaveLength(1);
    expect(
      (await messages.list(a, { first: 5, after: null, orderId: orders[1] })).items.map(
        (item) => item.orderId,
      ),
    ).toEqual([orders[1]]);
    expect((await messages.list(b, { first: 5, after: null })).items).toHaveLength(1);
  });

  it("merges, erases and exports a customer's messages, keeping their opt-outs", async () => {
    const [ayesha, duplicate, bilal] = [newId(), newId(), newId()];
    await messages.queue(a.shopId, { ...placed(newId()), customerId: duplicate });
    await messages.queue(a.shopId, { ...placed(newId()), customerId: ayesha });
    // A draft's message names no customer: found by her number.
    await messages.queue(a.shopId, placed(newId()));
    await messages.queue(a.shopId, { ...placed(newId(), BILAL), customerId: bilal });
    // Never written to by SMS: no shop to stop.
    expect(await messages.optOut('sms', AYESHA, 'stop')).toBeNull();
    await messages.optOut('whatsapp', AYESHA, 'STOP');

    await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.merge(tx, a.shopId, duplicate, ayesha),
    );
    const { rows: owners } = await admin.query<{ customer_id: string | null }>(
      'SELECT customer_id FROM messaging.messages ORDER BY created_at, id',
    );
    expect(owners.map((row) => row.customer_id)).toEqual([ayesha, ayesha, null, bilal]);

    const identity = { id: ayesha, phones: [AYESHA], email: null };
    const file = await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.export(tx, a.shopId, identity),
    );
    expect(file).toMatchObject({
      messages: [
        {
          kind: 'order_placed',
          channel: 'whatsapp',
          to: AYESHA,
          status: 'skipped',
          said: { name: 'Ayesha', order: '#1001' },
        },
        { status: 'skipped' },
        { status: 'skipped' },
      ],
      messageOptOuts: [{ channel: 'whatsapp', number: AYESHA, said: 'STOP' }],
    });
    expect(
      await db.tenant(a.shopId, (tx) =>
        MESSAGING_CUSTOMER_DATA.erasureBlockers(tx, a.shopId, ayesha),
      ),
    ).toEqual([]);

    await db.tenant(a.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.erase(tx, a.shopId, identity, 'system'),
    );
    expect((await rows()).map((row) => row.status)).toEqual(['pending']);
    // The shop never writes to her again by mistake.
    expect([...(await messages.optedOut(a.shopId, 'whatsapp', [AYESHA]))]).toEqual([AYESHA]);
  });

  it("keeps the shop's settings, checked, audited and announced when they change", async () => {
    expect(await settings.get(a)).toEqual({
      routing: 'rich',
      language: 'en',
      disabled: [],
      alertsPhone: null,
      updatedAt: null,
    });
    const wrong = await settings.update(a, {
      routing: 'cheap' as never,
      language: 'fr' as never,
      disabled: ['order_placed', 'order_lost'],
      alertsPhone: '12345',
    });
    expect(wrong.ok || wrong.errors.map((error) => [error.field.join('.'), error.code])).toEqual([
      ['input.routing', 'INVALID'],
      ['input.language', 'INVALID'],
      ['input.disabled', 'INVALID'],
      ['input.alertsPhone', 'INVALID'],
    ]);

    const changed = unwrap(
      await settings.update(a, {
        language: 'ur',
        disabled: ['order_shipped', 'order_placed', 'order_shipped'],
      }),
    );
    expect(changed).toMatchObject({
      routing: 'rich',
      language: 'ur',
      disabled: ['order_placed', 'order_shipped'],
    });
    expect(changed.updatedAt).toBeInstanceOf(Date);
    // Nothing new: nothing recorded.
    unwrap(
      await settings.update(a, { language: 'ur', disabled: ['order_placed', 'order_shipped'] }),
    );
    unwrap(await settings.update(a, { routing: 'economy' }));
    // Hatti's alerts to the shop: a Pakistani mobile, kept in E.164; blank stops them.
    expect(unwrap(await settings.update(a, { alertsPhone: ' 0300 1234567 ' })).alertsPhone).toBe(
      '+923001234567',
    );
    expect(unwrap(await settings.update(a, {})).alertsPhone).toBe('+923001234567');
    expect(unwrap(await settings.update(a, { alertsPhone: '' })).alertsPhone).toBeNull();
    expect(await settings.get(b)).toMatchObject({ routing: 'rich', updatedAt: null });

    const { rows: events } = await admin.query<{ event_type: string; payload: { changed: [] } }>(
      'SELECT event_type, payload FROM platform.outbox_events ORDER BY id',
    );
    expect(events.map((event) => [event.event_type, event.payload.changed])).toEqual([
      ['messaging_settings.updated', ['language', 'disabled']],
      ['messaging_settings.updated', ['routing']],
      ['messaging_settings.updated', ['alertsPhone']],
      ['messaging_settings.updated', ['alertsPhone']],
    ]);
    const { rows: audit } = await admin.query<{ action: string; details: object }>(
      'SELECT action, details FROM platform.audit_log ORDER BY id',
    );
    expect(audit).toMatchObject([
      {
        action: 'messaging_settings.updated',
        details: { changed: ['language', 'disabled'], language: 'ur', before: null },
      },
      {
        action: 'messaging_settings.updated',
        details: { changed: ['routing'], routing: 'economy', before: { language: 'ur' } },
      },
      { action: 'messaging_settings.updated', details: { changed: ['alertsPhone'] } },
      { action: 'messaging_settings.updated', details: { changed: ['alertsPhone'] } },
    ]);
    // The log keeps no contact details: never the number itself.
    expect(JSON.stringify(audit)).not.toContain('923001234567');
  });
});

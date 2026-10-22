import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageRetention } from './retention.js';

const server = testDatabaseServer();

const AT = new Date('2026-10-22T09:00:00Z');
/** Thirteen months before AT, and eleven: one past what is kept, one within it. */
const OLD = '2025-09-22T09:00:00Z';
const RECENT = '2025-11-22T09:00:00Z';
const AYESHA = '+923001234567';
const BILAL = '+923011234567';

describe.skipIf(!server)("Messages' content kept twelve months (ADR-738)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let retention: MessageRetention;
  const a = newId();
  const b = newId();

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'retention-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [a, b]);
    retention = new MessageRetention(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(`
      DELETE FROM messaging.messages; DELETE FROM messaging.conversations;
      DELETE FROM messaging.contact_messages`);
  });

  async function message(shopId: string, at: string, error: string | null = null): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.messages
         (shop_id, kind, channel, recipient, language, variables, dedupe_key, status, error,
          sent_at, created_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', '{"name": "Ayesha", "total": "Rs 2,400"}',
               $3, 'sent', $4, $5, $5)
       RETURNING id`,
      [shopId, AYESHA, `order_placed:${newId()}`, error, at],
    );
    return rows[0]!.id;
  }

  async function conversation(
    shopId: string,
    phone: string,
    messages: { at: string; direction?: 'inbound' | 'outbound' }[],
    unread = 0,
  ): Promise<string> {
    const last = messages
      .map((each) => each.at)
      .sort()
      .at(-1)!;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.conversations (shop_id, customer_phone, unread, last_message_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [shopId, phone, unread, last],
    );
    const id = rows[0]!.id;
    for (const each of messages) {
      const outbound = each.direction === 'outbound';
      await admin.query(
        `INSERT INTO messaging.conversation_messages
           (shop_id, conversation_id, direction, body, at, status, actor_kind, actor_id)
         VALUES ($1, $2, $3, 'Is the lawn suit in stock?', $4, $5, $6, $7)`,
        [
          shopId,
          id,
          each.direction ?? 'inbound',
          each.at,
          outbound ? 'sent' : null,
          outbound ? 'staff' : null,
          outbound ? newId() : null,
        ],
      );
    }
    return id;
  }

  async function contactMessage(shopId: string, at: string): Promise<void> {
    await admin.query(
      `INSERT INTO messaging.contact_messages (shop_id, phone, body, created_at)
       VALUES ($1, $2, 'Do you deliver to Quetta?', $3)`,
      [shopId, AYESHA, at],
    );
  }

  it('clears what a message to a customer said past twelve months, keeping that it was sent', async () => {
    const old = await message(a, OLD, 'Re-engagement message');
    const otherShop = await message(b, OLD);
    const recent = await message(a, RECENT);

    const purged = await retention.purge(AT);

    expect(purged.messages).toBe(2);
    const { rows } = await admin.query(
      `SELECT id, variables, error, status, recipient, kind, sent_at FROM messaging.messages`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [old, otherShop]) {
      expect(byId.get(id)).toMatchObject({
        variables: {},
        error: null,
        status: 'sent',
        recipient: AYESHA,
        kind: 'order_placed',
      });
      expect(byId.get(id).sent_at).toEqual(new Date(OLD));
    }
    expect(byId.get(recent).variables).toEqual({ name: 'Ayesha', total: 'Rs 2,400' });

    // Cleared once: the next sweep finds nothing.
    expect((await retention.purge(AT)).messages).toBe(0);
  });

  it('deletes what customers wrote past twelve months, and conversations left with nothing', async () => {
    const gone = await conversation(a, AYESHA, [{ at: OLD }, { at: OLD, direction: 'outbound' }]);
    const kept = await conversation(
      a,
      BILAL,
      [{ at: OLD }, { at: OLD }, { at: RECENT }, { at: RECENT, direction: 'outbound' }],
      3,
    );

    const purged = await retention.purge(AT);

    expect(purged).toMatchObject({ conversationMessages: 4, conversations: 1 });
    const { rows: conversations } = await admin.query(
      'SELECT id, unread FROM messaging.conversations',
    );
    expect(conversations).toEqual([{ id: kept, unread: 1 }]);
    expect(conversations.some((row) => row.id === gone)).toBe(false);
    const { rows: left } = await admin.query(
      'SELECT direction, at FROM messaging.conversation_messages ORDER BY direction',
    );
    expect(left).toEqual([
      { direction: 'inbound', at: new Date(RECENT) },
      { direction: 'outbound', at: new Date(RECENT) },
    ]);
  });

  it('keeps a conversation whose messages are all recent, and its unread count', async () => {
    await conversation(b, AYESHA, [{ at: RECENT }, { at: RECENT }], 2);

    expect(await retention.purge(AT)).toEqual({
      messages: 0,
      conversationMessages: 0,
      conversations: 0,
      contactMessages: 0,
    });
    const { rows } = await admin.query('SELECT unread FROM messaging.conversations');
    expect(rows).toEqual([{ unread: 2 }]);
  });

  it('deletes contact form messages past twelve months', async () => {
    await contactMessage(a, OLD);
    await contactMessage(b, OLD);
    await contactMessage(a, RECENT);

    expect((await retention.purge(AT)).contactMessages).toBe(2);
    const { rows } = await admin.query('SELECT shop_id FROM messaging.contact_messages');
    expect(rows).toEqual([{ shop_id: a }]);
  });

  it('takes a batch at a time, the oldest first', async () => {
    const oldest = await message(a, '2025-01-01T00:00:00Z');
    await message(a, OLD);

    expect((await retention.purge(AT, 1)).messages).toBe(1);
    const { rows } = await admin.query(
      `SELECT id FROM messaging.messages WHERE variables = '{}'::jsonb`,
    );
    expect(rows).toEqual([{ id: oldest }]);
  });

  it('goes on past a shop whose rows could not be changed, telling the caller', async () => {
    await contactMessage(a, OLD);
    await contactMessage(b, OLD);
    // A shop whose transaction fails, as a lock held too long would.
    await admin.query(`
      CREATE FUNCTION public.refuse_a() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.shop_id = '${a}' THEN RAISE EXCEPTION 'locked'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER refuse_a BEFORE DELETE ON messaging.contact_messages
        FOR EACH ROW EXECUTE FUNCTION public.refuse_a()`);
    const failed: string[] = [];
    try {
      const purged = await retention.purge(AT, 1_000, (shopId) => failed.push(shopId));
      expect(purged.contactMessages).toBe(1);
      expect(failed).toEqual([a]);
      await expect(retention.purge(AT)).rejects.toThrow();
    } finally {
      await admin.query(`
        DROP TRIGGER refuse_a ON messaging.contact_messages; DROP FUNCTION public.refuse_a()`);
    }
  });
});

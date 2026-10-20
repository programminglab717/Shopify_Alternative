import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { CONTACT_MESSAGE_LIMITS } from '@hatti/storefront-api';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContactMessagesService } from './contact-messages.service.js';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import { MessagingEvents } from './events.js';

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

describe.skipIf(!server)(
  "Messages through the online store's contact form (OS-08, ADR-589)",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let admin: pg.Client;
    let messages: ContactMessagesService;
    const a = tenant(newId());
    const b = tenant(newId());

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      db = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'contact-messages-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
        a.shopId,
        b.shopId,
      ]);
      messages = new ContactMessagesService(db);
    });

    afterAll(async () => {
      await db?.close();
      await admin?.end();
      await testDb?.drop();
    });

    beforeEach(async () => {
      await admin.query(
        'DELETE FROM messaging.contact_messages; DELETE FROM platform.outbox_events',
      );
    });

    it("keeps what a shopper wrote, with how to answer them and the form's other fields", async () => {
      const received = await messages.receive(a.shopId, {
        name: ' Ayesha Khan ',
        phone: '0300 1234567',
        email: 'Ayesha@Example.PK',
        body: 'Is the lawn suit back in medium?',
        fields: { 'Order number': ' #1042 ', email: 'ignored', Empty: ' ' },
        page: '/pages/contact',
        language: 'ur',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      });
      if (!received.ok) throw new Error(JSON.stringify(received.errors));
      const [message] = (await messages.list(a, { first: 10 })).items;
      expect(message).toEqual({
        id: received.value.id,
        name: 'Ayesha Khan',
        email: 'ayesha@example.pk',
        phone: AYESHA,
        body: 'Is the lawn suit back in medium?',
        fields: { 'Order number': '#1042' },
        page: '/pages/contact',
        language: 'ur',
        receivedAt: expect.any(Date) as unknown,
        readAt: null,
      });
      // Said to the outbox, without who wrote or what.
      const { rows: events } = await admin.query<{ aggregate_id: string; payload: unknown }>(
        'SELECT aggregate_id, payload FROM platform.outbox_events WHERE event_type = $1',
        [MessagingEvents.ContactMessageReceived],
      );
      expect(events).toEqual([{ aggregate_id: received.value.id, payload: { language: 'ur' } }]);
      // An email alone, or a number alone, will do.
      expect(
        (await messages.receive(a.shopId, { email: 'bilal@example.pk', body: 'Hello' })).ok,
      ).toBe(true);
      expect((await messages.receive(a.shopId, { phone: '03217654321', body: 'Hello' })).ok).toBe(
        true,
      );
    });

    it('says what will not do, field by field', async () => {
      const errors = async (input: Parameters<ContactMessagesService['receive']>[1]) => {
        const result = await messages.receive(a.shopId, input);
        return result.ok
          ? []
          : result.errors.map((error) => [error.field.join('.'), error.message]);
      };
      expect(await errors({ body: ' ' })).toEqual([
        ['email', 'Email or a mobile number is needed, to answer you'],
        ['body', "Body can't be blank"],
      ]);
      expect(await errors({ email: 'nope', phone: '12', body: 'Hi' })).toEqual([
        ['email', 'Email must be an email address, like name@example.com'],
        ['phone', 'Phone must be a Pakistani mobile number, like 0300 1234567'],
      ]);
      expect(
        await errors({ phone: AYESHA, body: 'x'.repeat(CONTACT_MESSAGE_LIMITS.body + 1) }),
      ).toEqual([
        ['body', `Body is too long (maximum is ${CONTACT_MESSAGE_LIMITS.body} characters)`],
      ]);
      const many = Object.fromEntries(
        Array.from({ length: CONTACT_MESSAGE_LIMITS.fields + 1 }, (_, index) => [`F${index}`, 'v']),
      );
      expect(await errors({ phone: AYESHA, body: 'Hi', fields: many })).toEqual([
        ['fields', 'The form has too many fields'],
      ]);
      expect(
        await errors({
          phone: AYESHA,
          body: 'Hi',
          fields: { Size: 'x'.repeat(CONTACT_MESSAGE_LIMITS.fieldValue + 1) },
        }),
      ).toEqual([
        ['Size', `Size is too long (maximum is ${CONTACT_MESSAGE_LIMITS.fieldValue} characters)`],
      ]);
      const { rows } = await admin.query('SELECT 1 FROM messaging.contact_messages');
      expect(rows).toEqual([]);
    });

    it('lists them the latest first, counts and marks the unread, deletes them, in their shop alone', async () => {
      const ids: string[] = [];
      for (const body of ['First', 'Second', 'Third']) {
        const received = await messages.receive(a.shopId, { phone: AYESHA, body });
        if (!received.ok) throw new Error('Expected it kept');
        ids.push(received.value.id);
      }
      const page = await messages.list(a, { first: 2 });
      expect([page.items.map((m) => m.body), page.hasNextPage]).toEqual([
        ['Third', 'Second'],
        true,
      ]);
      const next = await messages.list(a, { first: 2, after: page.items.at(-1)!.id });
      expect(next.items.map((m) => m.body)).toEqual(['First']);
      expect(await messages.unreadCount(a)).toBe(3);

      const read = await messages.markRead(a, ids[1]!, true);
      expect(read?.readAt).toBeInstanceOf(Date);
      expect(
        (await messages.list(a, { first: 10, unread: true })).items.map((m) => m.body),
      ).toEqual(['Third', 'First']);
      expect(await messages.unreadCount(a)).toBe(2);
      expect((await messages.markRead(a, ids[1]!, false))?.readAt).toBeNull();
      expect(await messages.unreadCount(a)).toBe(3);

      // Another shop sees, marks and deletes none of them.
      expect(await messages.get(b, ids[0]!)).toBeNull();
      expect(await messages.markRead(b, ids[0]!, true)).toBeNull();
      expect(await messages.delete(b, ids[0]!)).toBe(false);
      expect((await messages.list(b, { first: 10 })).items).toEqual([]);

      expect(await messages.delete(a, ids[0]!)).toBe(true);
      expect(await messages.delete(a, ids[0]!)).toBe(false);
      expect(await messages.unreadCount(a)).toBe(2);
    });

    it('gives what a customer wrote in their file, and erases it with them, by number or email', async () => {
      await messages.receive(a.shopId, { phone: AYESHA, body: 'By number' });
      await messages.receive(a.shopId, {
        email: 'AYESHA@example.pk',
        body: 'By email',
        fields: { 'Order number': '#1042' },
      });
      await messages.receive(a.shopId, { phone: '+923217654321', body: 'Someone else' });
      await messages.receive(b.shopId, { phone: AYESHA, body: 'Another shop' });
      const customer = { id: newId(), phones: [AYESHA], email: 'ayesha@example.pk' };

      const file = await db.tenant(a.shopId, (tx) =>
        MESSAGING_CUSTOMER_DATA.export(tx, a.shopId, customer),
      );
      expect((file as { contactMessages: unknown[] }).contactMessages).toEqual([
        expect.objectContaining({ number: AYESHA, email: null, said: 'By number', fields: {} }),
        expect.objectContaining({
          number: null,
          email: 'ayesha@example.pk',
          said: 'By email',
          fields: { 'Order number': '#1042' },
        }),
      ]);

      await db.tenant(a.shopId, (tx) =>
        MESSAGING_CUSTOMER_DATA.erase(tx, a.shopId, customer, 'system'),
      );
      const { rows } = await admin.query<{ body: string }>(
        'SELECT body FROM messaging.contact_messages ORDER BY body',
      );
      expect(rows).toEqual([{ body: 'Another shop' }, { body: 'Someone else' }]);
    });
  },
);

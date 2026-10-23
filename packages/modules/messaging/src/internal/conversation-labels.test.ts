import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsService } from './conversations.service.js';

const server = testDatabaseServer();

function staff(shopId: string): TenantContext {
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

describe.skipIf(!server)("Labels on the inbox's conversations (MSG-06, ADR-764)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let inbox: ConversationsService;
  const shop = newId();
  const other = newId();
  const ids = { first: '', second: '', third: '', elsewhere: '' };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'conversation-labels-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shop,
      other,
    ]);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.conversations (shop_id, customer_phone, last_message_at, status)
       VALUES ($1, '+923001234567', now() - interval '2 hours', 'open'),
              ($1, '+923211234567', now() - interval '1 hour', 'open'),
              ($1, '+923331234567', now(), 'closed'),
              ($2, '+923001234567', now(), 'open')
       RETURNING id`,
      [shop, other],
    );
    [ids.first, ids.second, ids.third, ids.elsewhere] = rows.map((row) => row.id) as [
      string,
      string,
      string,
      string,
    ];
    inbox = new ConversationsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('labels conversations as the shop writes its labels, lists those with one, and counts the open ones', async () => {
    const asStaff = staff(shop);
    const first = await inbox.setLabels(asStaff, ids.first, [' Delivery ', 'size', 'delivery', '']);
    expect(first.ok && first.value.labels).toEqual(['Delivery', 'size']);
    // A label the shop uses already is written as it is, in whatever case it is given.
    const second = await inbox.setLabels(asStaff, ids.second, ['DELIVERY', 'Refund']);
    expect(second.ok && second.value.labels).toEqual(['Delivery', 'Refund']);
    await inbox.setLabels(asStaff, ids.third, ['refund']);
    // Another shop's labels are its own.
    await inbox.setLabels(staff(other), ids.elsewhere, ['delivery']);

    const page = (label: string) =>
      inbox
        .list(asStaff, { first: 10, after: null, label })
        .then(({ items }) => items.map((each) => each.id));
    expect(await page('Delivery')).toEqual([ids.second, ids.first]);
    expect(await page('Refund')).toEqual([ids.third, ids.second]);
    expect(await page('Wrong size')).toEqual([]);
    expect(await inbox.labels(asStaff)).toEqual([
      { name: 'Delivery', open: 2 },
      { name: 'Refund', open: 1 },
      { name: 'size', open: 1 },
    ]);
    expect(await inbox.labels(staff(other))).toEqual([{ name: 'delivery', open: 1 }]);

    // None takes them all off.
    const cleared = await inbox.setLabels(asStaff, ids.first, []);
    expect(cleared.ok && cleared.value.labels).toEqual([]);
    expect(await page('Delivery')).toEqual([ids.second]);
  });

  it('refuses too many labels, one too long, and a conversation the shop does not have', async () => {
    const asStaff = staff(shop);
    const eleven = Array.from({ length: 11 }, (_, index) => `label ${index}`);
    expect(await inbox.setLabels(asStaff, ids.second, eleven)).toMatchObject({
      ok: false,
      errors: [{ field: ['labels'], code: 'TOO_MANY' }],
    });
    expect(await inbox.setLabels(asStaff, ids.second, ['x'.repeat(41)])).toMatchObject({
      ok: false,
      errors: [{ field: ['labels'], code: 'TOO_LONG' }],
    });
    expect(await inbox.setLabels(asStaff, ids.elsewhere, ['size'])).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    const { rows } = await admin.query('SELECT labels FROM messaging.conversations WHERE id = $1', [
      ids.second,
    ]);
    expect(rows[0]).toEqual({ labels: ['Delivery', 'Refund'] });
  });
});

import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsService } from './conversations.service.js';

const server = testDatabaseServer();

function staff(shopId: string, userId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId,
      sessionId: newId(),
      role: 'confirmation_agent',
      authenticatedAt: new Date(),
    },
    scopes: new Set(['write_conversations']),
  };
}

describe.skipIf(!server)('Conversations given to staff (MSG-06, ADR-759)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let inbox: ConversationsService;
  const shop = newId();
  const sana = newId();
  const bilal = newId();
  const ids = { first: '', second: '' };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'conversation-assignment-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.conversations (shop_id, customer_phone, last_message_at)
       VALUES ($1, '+923001234567', now() - interval '1 hour'), ($1, '+923211234567', now())
       RETURNING id`,
      [shop],
    );
    [ids.first, ids.second] = [rows[0]!.id, rows[1]!.id];
    inbox = new ConversationsService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('gives a conversation to one member of staff, found by whom it is given to, and taken back by them or a manager', async () => {
    const asSana = staff(shop, sana);
    const asBilal = staff(shop, bilal);
    const taken = await inbox.assign(asSana, ids.first, sana, { fromOthers: false });
    expect(taken.ok && taken.value.assigneeId).toBe(sana);
    const page = (options: { assigneeId?: string; unassigned?: boolean }) =>
      inbox
        .list(asSana, { first: 10, after: null, ...options })
        .then(({ items }) => items.map((each) => each.id));
    expect(await page({ assigneeId: sana })).toEqual([ids.first]);
    expect(await page({ unassigned: true })).toEqual([ids.second]);

    // Another agent cannot take it from them, nor give it back for them.
    expect(await inbox.assign(asBilal, ids.first, bilal, { fromOthers: false })).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], code: 'INVALID' }],
    });
    expect(await inbox.assign(asBilal, ids.first, null, { fromOthers: false })).toMatchObject({
      ok: false,
    });
    // A manager gives it to whom they choose.
    const moved = await inbox.assign(asBilal, ids.first, bilal, { fromOthers: true });
    expect(moved.ok && moved.value.assigneeId).toBe(bilal);
    const back = await inbox.assign(asBilal, ids.first, null, { fromOthers: false });
    expect(back.ok && back.value.assigneeId).toBeNull();
    const { rows } = await admin.query(
      'SELECT assignee_id, assigned_at FROM messaging.conversations WHERE id = $1',
      [ids.first],
    );
    expect(rows[0]).toEqual({ assignee_id: null, assigned_at: null });
    expect(await inbox.assign(asSana, newId(), sana, { fromOthers: true })).toMatchObject({
      ok: false,
      errors: [{ code: 'NOT_FOUND' }],
    });
  });
});
